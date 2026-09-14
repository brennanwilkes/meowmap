/**
 * Dump the whole database to a local JSON file.
 *
 *   node scripts/backup.mjs                    # -> backups/meowmap-<ts>.json
 *   node scripts/backup.mjs --out path.json
 *   node scripts/backup.mjs --photos           # ALSO download every photo object
 *
 * The rows are cheap and tiny; the photos are not, so downloading them is opt-in. But
 * understand what a rows-only backup is worth: R2 is the only part of this stack that
 * bills rather than failing closed, so it is also the only part with no free undo. A
 * restore from a rows-only backup gives you every sighting pointing at an object that
 * may no longer exist. Use --photos for anything you would be upset to lose.
 *
 * Photos come over the PUBLIC read path rather than the R2 API: content-addressed, so
 * the URL is stable, and no extra token is needed.
 */

import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { API_BASE, d1 } from './cf.mjs';

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const valueOf = (f) => {
  const i = argv.indexOf(f);
  return i === -1 || i + 1 >= argv.length ? null : argv[i + 1];
};

const TABLES = ['cats', 'sightings', 'app_meta', 'audit_log'];

async function main() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const out = valueOf('--out') ?? join('backups', `meowmap-${stamp}.json`);

  const data = { takenAt: Date.now(), schema: 1, tables: {} };
  for (const t of TABLES) {
    data.tables[t] = d1(`SELECT * FROM ${t}`);
    console.log(`${t.padEnd(10)} ${data.tables[t].length} row(s)`);
  }

  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(data, null, 2));
  console.log(`\nWrote ${out}`);

  if (!has('--photos')) {
    console.log('Rows only. Pass --photos to also download the images.');
    return;
  }

  const dir = out.replace(/\.json$/, '-photos');
  mkdirSync(dir, { recursive: true });
  const hashes = new Set();
  for (const s of data.tables.sightings) {
    if (typeof s.photo_full === 'string') hashes.add(s.photo_full);
    if (typeof s.photo_thumb === 'string') hashes.add(s.photo_thumb);
  }

  let got = 0;
  let missing = 0;
  for (const hash of hashes) {
    const file = join(dir, `${hash}.jpg`);
    // Content-addressed, so a file already on disk is byte-identical by definition.
    if (existsSync(file)) { got++; continue; }
    const res = await fetch(`${API_BASE}/photo/${hash}`);
    if (!res.ok) {
      // Loudly, not silently: a referenced photo that is gone is the one thing a backup
      // must never paper over.
      console.error(`  MISSING ${hash} (HTTP ${res.status})`);
      missing++;
      continue;
    }
    writeFileSync(file, Buffer.from(await res.arrayBuffer()));
    got++;
  }
  console.log(`\n${got} photo(s) in ${dir}${missing > 0 ? `, ${missing} MISSING` : ''}`);
  if (missing > 0) process.exitCode = 1;
}

main();
