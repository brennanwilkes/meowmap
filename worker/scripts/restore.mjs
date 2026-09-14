/**
 * Restore a backup produced by backup.mjs.
 *
 *   node scripts/restore.mjs backups/meowmap-….json            # dry run
 *   node scripts/restore.mjs backups/meowmap-….json --apply
 *
 * REPLACES, never merges. The target tables are emptied first, so ids in the backup stay
 * the ids after the restore — which matters because every photo reference, every offline
 * client's cache and every audit row is keyed on them. A merge would have to renumber,
 * and renumbering silently re-points photos at the wrong cats.
 *
 * Photos are NOT restored here. They live in R2 under a content address, so if the
 * objects still exist the rows just work; if they do not, no amount of row-restoring
 * brings them back. `--check-photos` tells you which side you are on BEFORE you commit.
 */

import { readFileSync } from 'node:fs';
import { API_BASE, d1, q } from './cf.mjs';

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const file = argv.find((a) => !a.startsWith('--'));
const APPLY = has('--apply');

const COLUMNS = {
  cats: ['id', 'name', 'notes', 'created_at', 'updated_at', 'deleted_at'],
  sightings: [
    'id', 'client_id', 'cat_id', 'device_id', 'lat', 'lon', 'location_source',
    'accuracy_m', 'seen_at', 'coat', 'size', 'petted', 'note',
    'photo_full', 'photo_thumb', 'photo_w', 'photo_h',
    'embedding', 'coat_suggested', 'created_at', 'updated_at', 'deleted_at',
  ],
};

function literal(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return String(v);
  return q(String(v));
}

async function main() {
  if (file === undefined) {
    console.error('Usage: node scripts/restore.mjs <backup.json> [--apply] [--check-photos]');
    process.exit(1);
  }
  const backup = JSON.parse(readFileSync(file, 'utf8'));
  const cats = backup.tables?.cats ?? [];
  const sightings = backup.tables?.sightings ?? [];

  console.log(`Backup taken ${new Date(backup.takenAt).toISOString()}`);
  console.log(`  ${cats.length} cat(s), ${sightings.length} sighting(s)`);

  const live = d1('SELECT COUNT(*) AS n FROM sightings')[0]?.n ?? 0;
  console.log(`  target currently holds ${live} sighting(s) — these will be REPLACED\n`);

  if (has('--check-photos')) {
    const hashes = new Set();
    for (const s of sightings) {
      if (typeof s.photo_full === 'string') hashes.add(s.photo_full);
      if (typeof s.photo_thumb === 'string') hashes.add(s.photo_thumb);
    }
    let missing = 0;
    for (const h of hashes) {
      const res = await fetch(`${API_BASE}/photo/${h}`, { method: 'HEAD' });
      if (!res.ok) { console.log(`  MISSING photo ${h}`); missing++; }
    }
    console.log(`\n${hashes.size - missing}/${hashes.size} photos still in R2.\n`);
  }

  if (!APPLY) {
    console.log('Dry run. Pass --apply to restore.');
    return;
  }

  // Sightings first: they reference cats, so they must go before the cats they point at
  // are removed, and come back after those cats exist again.
  d1('DELETE FROM sightings');
  d1('DELETE FROM cats');

  for (const [table, cols] of Object.entries(COLUMNS)) {
    const rows = table === 'cats' ? cats : sightings;
    for (const r of rows) {
      const values = cols.map((c) => literal(r[c])).join(',');
      d1(`INSERT INTO ${table} (${cols.join(',')}) VALUES (${values})`);
    }
    console.log(`restored ${rows.length} ${table}`);
  }

  // Bump rather than restore the backup's version: clients hold ETags derived from it,
  // and going backwards would let a stale phone believe its cache is current.
  d1(`UPDATE app_meta SET data_version = data_version + 1, updated_at = ${Date.now()} WHERE id = 1`);
  console.log('\nRestored. Run `npm run reconcile` to re-sync the R2 counters.');
}

main();
