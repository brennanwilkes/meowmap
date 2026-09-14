import { execFileSync } from 'node:child_process';

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
 * List every object in the bucket.
 *
 * WRANGLER CANNOT DO THIS. `wrangler r2 object` only has get/put/delete — there is no
 * list subcommand in 4.131 — so this goes through the REST API and needs a token with
 * "Workers R2 Storage: Read". Scripts that only need to delete known keys should NOT
 * call this; compute reachability in SQL instead and stay on wrangler auth alone.
 */
export async function r2List() {
  const token = process.env.CLOUDFLARE_API_TOKEN;
  const account = process.env.CLOUDFLARE_ACCOUNT_ID ?? ACCOUNT_ID;
  if (token === undefined || token === '') {
    throw new Error(
      'Listing R2 objects needs CLOUDFLARE_API_TOKEN (Workers R2 Storage: Read).\n'
      + 'wrangler has no `r2 object list` command, so there is no OAuth path for it.',
    );
  }
  const out = [];
  let cursor = '';
  for (;;) {
    const url = new URL(`https://api.cloudflare.com/client/v4/accounts/${account}/r2/buckets/${BUCKET}/objects`);
    url.searchParams.set('prefix', PREFIX);
    url.searchParams.set('per_page', '1000');
    if (cursor !== '') url.searchParams.set('cursor', cursor);

    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const body = await res.json();
    if (!res.ok || body.success !== true) {
      throw new Error(`R2 list failed: ${res.status} ${JSON.stringify(body.errors ?? body)}`);
    }
    for (const o of body.result) out.push({ key: o.key, size: Number(o.size ?? 0) });
    cursor = body.result_info?.cursor ?? '';
    if (cursor === '') return out;
  }
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
