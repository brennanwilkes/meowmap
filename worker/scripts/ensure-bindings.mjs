/**
 * Idempotently ensures all Cloudflare bindings exist and applies any pending
 * DB migrations. Safe to run on every deploy.
 *
 * 1. Ensure D1 database exists; patch wrangler.toml __D1_ID__ placeholder.
 * 2. Ensure the R2 bucket exists.
 * 3. Bootstrap schema_migrations table.
 * 4. Read migrations/*.sql in numeric order; apply any not yet recorded.
 *
 * Adding a migration: drop a new file like 002_my_change.sql into worker/migrations/
 * and push. CI will apply it automatically on the next deploy.
 *
 * Lifted from vessel-tracker; the R2 half is the only addition. Deliberately NOT using
 * `npx wrangler r2 bucket create`, which errors when the bucket already exists —
 * idempotency is the entire contract of this script.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { execSync } from 'node:child_process';

const API_BASE = 'https://api.cloudflare.com/client/v4';

function mustEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

async function cfFetch(url, init = {}) {
  const token = mustEnv('CLOUDFLARE_API_TOKEN');
  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.success) {
    const msg = data?.errors?.[0]?.message ?? res.statusText;
    throw new Error(`Cloudflare API error (${res.status}): ${msg}`);
  }
  return data;
}

// ── D1 ───────────────────────────────────────────────────────────────────────

async function listD1Databases(accountId) {
  const data = await cfFetch(`${API_BASE}/accounts/${accountId}/d1/database`);
  return Array.isArray(data.result) ? data.result : [];
}

async function createD1Database(accountId, name) {
  const data = await cfFetch(`${API_BASE}/accounts/${accountId}/d1/database`, {
    method: 'POST',
    body: JSON.stringify({ name }),
  });
  return data.result;
}

async function ensureD1(accountId, name) {
  const all = await listD1Databases(accountId);
  const found = all.find((db) => db.name === name);
  if (found) return found;
  try {
    return await createD1Database(accountId, name);
  } catch {
    const all2 = await listD1Databases(accountId);
    const found2 = all2.find((db) => db.name === name);
    if (found2) return found2;
    throw new Error(`Could not create or find D1 database "${name}"`);
  }
}

// ── R2 ───────────────────────────────────────────────────────────────────────
// Two asymmetries with D1 that are easy to get wrong:
//   * R2 buckets bind BY NAME, so there is no __R2_ID__ placeholder to patch.
//   * The list response is `result.buckets`, not `result`.

async function listR2Buckets(accountId) {
  const data = await cfFetch(`${API_BASE}/accounts/${accountId}/r2/buckets?per_page=1000`);
  return Array.isArray(data.result?.buckets) ? data.result.buckets : [];
}

async function createR2Bucket(accountId, name) {
  const data = await cfFetch(`${API_BASE}/accounts/${accountId}/r2/buckets`, {
    method: 'POST',
    body: JSON.stringify({ name, locationHint: 'wnam' }),
  });
  return data.result;
}

async function ensureR2(accountId, name) {
  const all = await listR2Buckets(accountId);
  const found = all.find((b) => b.name === name);
  if (found) return found;
  try {
    return await createR2Bucket(accountId, name);
  } catch (err) {
    // Same create-race retry shape as ensureD1.
    const all2 = await listR2Buckets(accountId);
    const found2 = all2.find((b) => b.name === name);
    if (found2) return found2;
    // The overwhelmingly likely first-run failure. Say so by name rather than dumping
    // an opaque API error code at someone who has never enabled R2 before.
    throw new Error(
      `Could not create or find R2 bucket "${name}". If this is the first deploy, enable ` +
      `R2 once at https://dash.cloudflare.com/${accountId}/r2 — it requires a payment ` +
      `method on file even for the free tier. Then re-run. Underlying error: ${err.message}`
    );
  }
}

// ── Migrations ───────────────────────────────────────────────────────────────

function wranglerExec(sql, dbName, { local = false } = {}) {
  const flag = local ? '--local' : '--remote';
  execSync(
    `npx wrangler d1 execute ${dbName} ${flag} --command ${JSON.stringify(sql)}`,
    { stdio: 'inherit' }
  );
}

function wranglerExecFile(filePath, dbName, { local = false } = {}) {
  const flag = local ? '--local' : '--remote';
  execSync(
    `npx wrangler d1 execute ${dbName} ${flag} --file ${JSON.stringify(filePath)}`,
    { stdio: 'inherit' }
  );
}

async function getAppliedMigrations(dbName) {
  // Bootstrap the tracking table silently before querying it.
  wranglerExec(
    'CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)',
    dbName
  );
  const raw = execSync(
    `npx wrangler d1 execute ${dbName} --remote --command "SELECT id FROM schema_migrations ORDER BY id" --json`,
    { encoding: 'utf8' }
  );
  try {
    const rows = JSON.parse(raw);
    // wrangler --json returns [{results: [{id: N}, ...]}, ...]
    const results = Array.isArray(rows) ? rows[0]?.results ?? [] : [];
    return new Set(results.map((r) => Number(r.id)));
  } catch {
    return new Set();
  }
}

async function applyPendingMigrations(dbName, migrationsDir) {
  let files;
  try {
    files = await fs.readdir(migrationsDir);
  } catch {
    console.log('No migrations/ directory found — skipping.');
    return;
  }

  // Only process files matching NNN_*.sql; sort numerically by prefix
  const migrations = files
    .filter((f) => /^\d+_.+\.sql$/.test(f))
    .map((f) => ({ file: f, id: parseInt(f, 10) }))
    .sort((a, b) => a.id - b.id);

  if (migrations.length === 0) {
    console.log('No migration files found.');
    return;
  }

  const applied = await getAppliedMigrations(dbName);
  const pending = migrations.filter((m) => !applied.has(m.id));

  if (pending.length === 0) {
    console.log(`All ${migrations.length} migration(s) already applied.`);
    return;
  }

  console.log(`Applying ${pending.length} pending migration(s)...`);
  for (const { file, id } of pending) {
    const filePath = path.join(migrationsDir, file);
    console.log(`  Applying ${file} (id=${id})`);
    wranglerExecFile(filePath, dbName);
    // Record as applied
    wranglerExec(
      `INSERT INTO schema_migrations (id, applied_at) VALUES (${id}, ${Date.now()})`,
      dbName
    );
    console.log(`  ✓ ${file}`);
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const accountId = mustEnv('CLOUDFLARE_ACCOUNT_ID');
  const repoRoot = process.cwd();
  const wranglerPath = path.join(repoRoot, 'wrangler.toml');
  let wranglerToml = await fs.readFile(wranglerPath, 'utf8');

  const workerNameMatch = wranglerToml.match(/^\s*name\s*=\s*"([^"]+)"/m);
  const workerName = workerNameMatch?.[1] ?? 'worker';

  // 1. D1
  const d1NameMatch = wranglerToml.match(/database_name\s*=\s*"([^"]+)"/);
  const d1Name = d1NameMatch?.[1] ?? workerName;
  const d1 = await ensureD1(accountId, d1Name);
  wranglerToml = wranglerToml.replace(/database_id\s*=\s*"__D1_ID__"/g, `database_id = "${d1.uuid}"`);
  console.log(`D1 "${d1Name}" → ${d1.uuid}`);

  await fs.writeFile(wranglerPath, wranglerToml, 'utf8');

  // 2. R2
  const r2NameMatch = wranglerToml.match(/bucket_name\s*=\s*"([^"]+)"/);
  if (r2NameMatch === null) throw new Error('No bucket_name found in wrangler.toml');
  const r2Name = r2NameMatch[1];
  await ensureR2(accountId, r2Name);
  console.log(`R2 "${r2Name}" ready`);

  // 3. Migrations
  const migrationsDir = path.join(repoRoot, 'migrations');
  await applyPendingMigrations(d1Name, migrationsDir);

  console.log(JSON.stringify(
    { workerName, d1: { name: d1Name, id: d1.uuid }, r2: { name: r2Name } }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
