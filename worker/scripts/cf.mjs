import { execFileSync } from 'node:child_process';
// Circular with migrate.mjs, and safe: neither module calls the other while it is being
// evaluated, and both export hoisted function declarations.
import { ensureMigrations } from './migrate.mjs';

/* Shared Cloudflare plumbing for the admin scripts.
 *
 * RESOLVE THE DATABASE BY UUID, NEVER BY NAME. `database_id` in wrangler.toml is the
 * literal placeholder `__D1_ID__`, patched by CI at deploy time and never locally.
 * Passing the name does not help: wrangler matches the name against the config first and
 * then calls the API with the placeholder, so every script failed with
 * "database __D1_ID__ could not be found". That went unnoticed because the shell helpers
 * swallowed stderr, which made a broken script and an empty table look identical.
 */

export const DB_NAME = 'meowmap';
export const BUCKET = 'meowmap-photos';
export const PREFIX = 'photos/';
export const ACCOUNT_ID = 'a53d0d3cb40662b52e001ffd082d2f1f';

let cachedUuid = null;

function wrangler(args, maxBuffer = 64 * 1024 * 1024) {
  return execFileSync('npx', ['wrangler', ...args], { encoding: 'utf8', maxBuffer });
}

export function dbUuid() {
  if (cachedUuid !== null) return cachedUuid;
  const list = JSON.parse(wrangler(['d1', 'list', '--json']));
  const hit = list.find((d) => d.name === DB_NAME);
  if (hit === undefined) {
    throw new Error(`No D1 database named '${DB_NAME}' on this account. Check 'npx wrangler whoami'.`);
  }
  cachedUuid = hit.uuid;
  return cachedUuid;
}

export function d1(sql) {
  const raw = wrangler(['d1', 'execute', dbUuid(), '--remote', '--json', '--command', sql]);
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed) ? (parsed[0]?.results ?? []) : [];
}

/**
 * Several statements in ONE wrangler invocation, returning each statement's results.
 *
 * Spawning `npx wrangler` costs a couple of seconds before it does any work, so a delete
 * made of four one-statement calls spent most of its time starting processes — which is
 * what made the interactive browser feel hung. Semicolon-separated statements cost that
 * startup once.
 */
export function d1Many(sqls) {
  const raw = wrangler(['d1', 'execute', dbUuid(), '--remote', '--json', '--command', sqls.join('; ')]);
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) return [];
  return parsed.map((r) => r.results ?? []);
}

/**
 * True object count and total bytes, straight from wrangler — no API token.
 *
 * `r2 bucket info` is the only enumeration wrangler offers (there is no `r2 object
 * list`), and for the cost breaker it is exactly enough: the breaker cares how much is
 * stored, not which keys. Knowing WHICH objects to delete is the deletion journal's job.
 */
export function bucketInfo() {
  const raw = wrangler(['r2', 'bucket', 'info', BUCKET]);
  const count = raw.match(/object_count:\s*(\d+)/);
  const size = raw.match(/bucket_size:\s*([\d.]+)\s*(B|kB|MB|GB)/);
  if (count === null || size === null) throw new Error(`could not parse r2 bucket info:\n${raw}`);
  const unit = { B: 1, kB: 1e3, MB: 1e6, GB: 1e9 }[size[2]];
  return { objects: Number(count[1]), bytes: Math.round(Number(size[1]) * unit) };
}

/* ── the deletion journal ──────────────────────────────────────────────── */

/* The journal lives in a migration, so a database that has not been deployed since it
 * was added does not have the table. Apply pending migrations lazily rather than failing
 * with a raw SQLITE_ERROR — an admin script that cannot run until you deploy is useless
 * precisely when you need it. Imported lazily to keep the dependency one-directional. */
let schemaChecked = false;
function ensureJournalTable() {
  if (schemaChecked) return;
  schemaChecked = true;
  ensureMigrations();
}

/** Write the hashes down BEFORE the rows that name them are deleted. */
export function journalForDelete(hashes, reason) {
  ensureJournalTable();
  if (hashes.length === 0) return [];
  const now = Date.now();
  return hashes.map((h) =>
    `INSERT OR IGNORE INTO r2_gc_queue (hash, queued_at, reason) VALUES (${q(h)}, ${now}, ${q(reason)})`);
}

/**
 * Delete every object named in the journal, clearing entries as they succeed.
 *
 * Safe to run at any time and safe to run twice: an entry is only queued once nothing
 * references it, and a delete that fails stays queued for the next run.
 */
export function sweepJournal() {
  ensureJournalTable();
  const queued = d1('SELECT hash FROM r2_gc_queue');
  // Belt and braces: never delete an object a row has come to reference again. Content
  // addressing makes that possible — re-uploading the same photo revives the same key.
  const live = new Set(
    d1('SELECT photo_full AS k FROM sightings UNION SELECT photo_thumb FROM sightings').map((r) => r.k),
  );
  const done = [];
  const failed = [];
  for (const { hash } of queued) {
    if (live.has(hash)) { done.push(hash); continue; }
    try { r2Delete(`${PREFIX}${hash}`); done.push(hash); } catch { failed.push(hash); }
  }
  if (done.length > 0) {
    d1(`DELETE FROM r2_gc_queue WHERE hash IN (${done.map(q).join(',')})`);
  }
  return { deleted: done.length, failed };
}

/* `wrangler r2 object delete`, NOT `r2 bucket object delete` — the latter is a plausible
 * guess that does not exist, and wrangler's error for it is a bucket help dump that says
 * nothing about the real command. */
export function r2Delete(key) {
  wrangler(['r2', 'object', 'delete', `${BUCKET}/${key}`, '--remote']);
}

/* Device ids are opaque UUIDs minted in localStorage. Naming the ones we recognise is
 * the difference between an audit trail you can read and one you have to decode. Add a
 * line here when a new device shows up in `db-audit-devices`. */
export const DEVICE_NAMES = {
  '663ce59c-7ce6-4301-9642-4582da9b0de5': 'Brennan iPhone',
};

export const deviceName = (id) =>
  (id === null || id === undefined ? '—' : (DEVICE_NAMES[id] ?? id.slice(0, 8)));

export const API_BASE = 'https://meowmap-api.brennan-a53.workers.dev';

/** SQL string literal. Everything here is developer-supplied, but a stray quote in a
 *  note should break the query loudly rather than change what it deletes. */
export function q(s) {
  if (typeof s !== 'string') throw new Error(`not a string: ${s}`);
  return `'${s.replace(/'/g, "''")}'`;
}
