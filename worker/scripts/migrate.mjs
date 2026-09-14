/**
 * Apply any migrations the remote database has not seen.
 *
 *   npm run migrate            # apply pending
 *   npm run migrate -- --list  # show what is applied and what is pending
 *
 * CI runs the same migrations through `ensure-bindings.mjs`, against the same
 * `schema_migrations` table, so the two agree and neither re-applies the other's work.
 * This one exists because ensure-bindings needs a REST API token (it creates bindings),
 * while this needs only your wrangler login — and an admin script that cannot run until
 * you have deployed is no use when what you are trying to fix is the data.
 *
 * That gap was not hypothetical: `npm run gc` failed with "no such table: r2_gc_queue"
 * because the table it depends on only existed in a file on disk.
 */

import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { d1, d1File } from './cf.mjs';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

/** `NNN_name.sql` in numeric order. Sorting the filenames as strings would put 10 before 2. */
function migrations() {
  return readdirSync(DIR)
    .filter((f) => /^\d+_.*\.sql$/.test(f))
    .map((f) => ({ id: Number(f.split('_')[0]), file: f }))
    .sort((a, b) => a.id - b.id);
}

function applied() {
  d1('CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)');
  return new Set(d1('SELECT id FROM schema_migrations').map((r) => r.id));
}

/**
 * Bring the database up to date. Exported so the scripts that depend on a table can call
 * it rather than failing with a raw SQLITE_ERROR the reader has to decode.
 */
export function ensureMigrations() {
  const done = applied();
  const pending = migrations().filter((m) => !done.has(m.id));
  for (const m of pending) {
    /* Hand the FILE to wrangler and let it parse the script. The previous version split
     * on `;` here, which is not something you can do to SQL with a regex: 001 alone
     * contains "null when unnamed; see the unique index below" and "read with a bare
     * SELECT; an index would be…" in trailing comments, each of which split mid-sentence
     * and sent English to D1 as a statement. CI has always used --file for this reason;
     * now both paths parse identically, which is the point of them sharing a table. */
    d1File(join(DIR, m.file));
    d1(`INSERT INTO schema_migrations (id, applied_at) VALUES (${m.id}, ${Date.now()})`);
    console.log(`applied ${m.file}`);
  }
  return pending.length;
}

function main() {
  if (process.argv.includes('--list')) {
    const done = applied();
    for (const m of migrations()) {
      console.log(`${done.has(m.id) ? '  applied' : '  PENDING'}  ${m.file}`);
    }
    return;
  }
  const n = ensureMigrations();
  console.log(n === 0 ? 'Already up to date.' : `Applied ${n} migration(s).`);
}

// Only run as a CLI, not when imported for ensureMigrations().
if (process.argv[1] !== undefined && process.argv[1].endsWith('migrate.mjs')) main();
