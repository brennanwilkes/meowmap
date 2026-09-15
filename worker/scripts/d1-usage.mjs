#!/usr/bin/env node
/* Which database is eating the account's D1 budget?
 *
 * THE DAILY CAPS ARE PER ACCOUNT, NOT PER DATABASE — 5,000,000 rows read and 100,000
 * written, resetting 00:00 UTC. So a sibling project on the same Cloudflare account can
 * exhaust them and take this one down with it, and the symptom here is indistinguishable
 * from a bug of our own: queries that touch rows start failing while `SELECT 1` still
 * works, and /health (one row) answers while /sightings (two table scans) does not.
 *
 * That happened on 2026-09-14 and the first two guesses were both wrong — a Cloudflare
 * outage, then our own migration. This script is so the third time takes one command.
 *
 * Control-plane only: it reads no rows, so it still works when the cap is blown, which
 * is exactly when it is needed.
 *
 *   npm run d1-usage
 */

import { execFileSync } from 'node:child_process';

const CAP_READ = 5_000_000;
const CAP_WRITE = 100_000;

function wrangler(args) {
  return execFileSync('npx', ['wrangler', ...args], {
    encoding: 'utf8',
    // Never swallow stderr in these scripts: a broken script and an empty table must not
    // look identical. See the db-common note in CLAUDE.md.
    stdio: ['ignore', 'pipe', 'inherit'],
  });
}

/* `wrangler d1 info` renders a box-drawing table and its --json is not dependable across
 * versions, so the numbers are pulled out of the rendered cells. The ROW ORDER is the
 * contract: name, created_at, num_tables, region, jurisdiction, size, read_queries,
 * write_queries, rows_read, rows_written, replication. When only one column is rendered
 * (wrangler collapses it when the id is the header) the labels are absent entirely,
 * which is why this counts cells rather than matching label text. */
function cells(text) {
  return text.split('\n')
    .filter((l) => l.startsWith('│'))
    .map((l) => l.split('│').slice(1, -1).map((c) => c.trim()))
    .map((c) => (c.length === 2 ? c[1] : c[0]))
    .filter((v) => v !== undefined && v !== '');
}

const num = (s) => Number(String(s).replace(/,/g, ''));

const list = wrangler(['d1', 'list']);
const dbs = list.split('\n')
  .filter((l) => l.startsWith('│') && /[0-9a-f]{8}-[0-9a-f]{4}/.test(l))
  .map((l) => {
    const c = l.split('│').slice(1, -1).map((x) => x.trim());
    return { uuid: c[0], name: c[1] };
  });

if (dbs.length === 0) {
  console.error('No D1 databases found. Is wrangler logged in to the right account?');
  process.exit(1);
}

const rows = [];
for (const db of dbs) {
  // Addressed by UUID, never by name: `wrangler d1 info <name>` resolves the name against
  // wrangler.toml, whose database_id is the literal __D1_ID__ that CI patches at deploy.
  const v = cells(wrangler(['d1', 'info', db.uuid]));
  const tail = v.slice(-5);   // read_q, write_q, rows_read, rows_written, replication
  rows.push({
    name: db.name,
    size: v[v.length - 6],
    readQueries: num(tail[0]),
    writeQueries: num(tail[1]),
    rowsRead: num(tail[2]),
    rowsWritten: num(tail[3]),
  });
}

const totalRead = rows.reduce((a, r) => a + r.rowsRead, 0);
const totalWritten = rows.reduce((a, r) => a + r.rowsWritten, 0);
const pct = (n, total) => (total === 0 ? '0.0' : ((n / total) * 100).toFixed(1));

const w = Math.max(8, ...rows.map((r) => r.name.length));
console.log(`\nD1 usage, last 24h — the caps below are ACCOUNT-WIDE and shared\n`);
console.log(
  `${'database'.padEnd(w)}  ${'size'.padStart(9)}  ${'rows read'.padStart(12)}   share`
  + `  ${'rows written'.padStart(12)}   share  ${'rows/query'.padStart(10)}`,
);
console.log('-'.repeat(w + 66));
for (const r of rows.sort((a, b) => b.rowsRead - a.rowsRead)) {
  // Rows per read query is the diagnostic that matters: a high number means table scans,
  // which is how a small number of requests can burn millions of rows.
  const per = r.readQueries === 0 ? 0 : Math.round(r.rowsRead / r.readQueries);
  console.log(
    `${r.name.padEnd(w)}  ${r.size.padStart(9)}  ${r.rowsRead.toLocaleString().padStart(12)}`
    + `  ${pct(r.rowsRead, totalRead).padStart(5)}%`
    + `  ${r.rowsWritten.toLocaleString().padStart(12)}  ${pct(r.rowsWritten, totalWritten).padStart(5)}%`
    + `  ${String(per).padStart(10)}`,
  );
}
console.log('-'.repeat(w + 66));
console.log(
  `${'TOTAL'.padEnd(w)}  ${''.padStart(9)}  ${totalRead.toLocaleString().padStart(12)}`
  + `  ${pct(totalRead, CAP_READ).padStart(5)}%`
  + `  ${totalWritten.toLocaleString().padStart(12)}  ${pct(totalWritten, CAP_WRITE).padStart(5)}%`,
);
console.log(`\n  read  cap ${CAP_READ.toLocaleString()} / day   used ${pct(totalRead, CAP_READ)}%`);
console.log(`  write cap ${CAP_WRITE.toLocaleString()} / day   used ${pct(totalWritten, CAP_WRITE)}%`);
console.log(`  resets 00:00 UTC. Over the cap, every query that reads rows fails;`);
console.log(`  a query reading zero rows still succeeds, which is why it looks intermittent.\n`);
