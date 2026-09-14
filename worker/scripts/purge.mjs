/**
 * Delete data for real — rows AND the photos they reference.
 *
 *   node scripts/purge.mjs --sighting 3 4           # specific sightings
 *   node scripts/purge.mjs --cat 2                  # a cat; its sightings go loose
 *   node scripts/purge.mjs --before 2026-09-15      # everything seen before a date
 *   node scripts/purge.mjs --all                    # every sighting and cat
 *   …plus --apply to actually do it. Everything is a dry run by default.
 *
 * WHY THIS HARD-DELETES WHILE THE APP SOFT-DELETES. The app tombstones because rowids
 * are recycled and a recycled id would silently re-point an offline client's cached
 * record at a different cat. That reasoning is about *live* data with clients holding
 * references. This script exists for test data you want GONE — tombstones would keep
 * pinning R2 bytes forever and keep showing up in every reachability report.
 *
 * So the safety here is different in kind:
 *   - dry run by default, and it prints every row it is about to destroy;
 *   - --apply is required, and --all additionally requires --yes-really;
 *   - photos are deleted by REACHABILITY after the rows are gone, never by assuming a
 *     hash belongs to one sighting. Keys are content-addressed, so two sightings can
 *     share an object and deleting eagerly would blank a photo that is still in use.
 *
 * Anyone still holding a deleted id offline will get a 404 on that photo, which is the
 * honest outcome: the data really is gone.
 */

import { bucketInfo, d1, d1Many, journalForDelete, sweepJournal } from './cf.mjs';

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const APPLY = has('--apply');

function valuesAfter(flag) {
  const i = argv.indexOf(flag);
  if (i === -1) return [];
  const out = [];
  for (let j = i + 1; j < argv.length && !argv[j].startsWith('--'); j++) out.push(argv[j]);
  return out;
}

function intList(flag) {
  return valuesAfter(flag).map((v) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 0) throw new Error(`${flag} expects integer ids, got '${v}'`);
    return n;
  });
}

function selectSightings() {
  if (has('--all')) return d1('SELECT id, client_id, cat_id, seen_at, note, photo_full, photo_thumb FROM sightings');

  const clauses = [];
  const ids = intList('--sighting');
  if (ids.length > 0) clauses.push(`id IN (${ids.join(',')})`);

  const cats = intList('--cat');
  if (cats.length > 0) clauses.push(`cat_id IN (${cats.join(',')})`);

  const before = valuesAfter('--before')[0];
  if (before !== undefined) {
    const t = Date.parse(`${before}T00:00:00Z`);
    if (!Number.isFinite(t)) throw new Error(`--before expects YYYY-MM-DD, got '${before}'`);
    clauses.push(`seen_at < ${t}`);
  }

  if (clauses.length === 0) return null;
  return d1(`SELECT id, client_id, cat_id, seen_at, note, photo_full, photo_thumb FROM sightings WHERE ${clauses.join(' OR ')}`);
}

function main() {
  if (argv.length === 0 || has('--help')) {
    console.log(`Usage:
  node scripts/purge.mjs --sighting <id...>   delete specific sightings
  node scripts/purge.mjs --cat <id...>        delete a cat and its sightings
  node scripts/purge.mjs --before YYYY-MM-DD  delete sightings seen before a date
  node scripts/purge.mjs --all                delete every sighting and cat
  --apply        actually do it (default is a dry run)
  --yes-really   additionally required for --all
  --keep-cats    with --cat, delete only the sightings and leave the cat row`);
    return;
  }

  if (has('--all') && APPLY && !has('--yes-really')) {
    console.error('--all --apply also needs --yes-really. This deletes every cat and sighting.');
    process.exit(1);
  }

  const sightings = selectSightings();
  if (sightings === null) {
    console.error('Nothing selected. Pass --sighting, --cat, --before or --all.');
    process.exit(1);
  }

  const catIds = has('--all')
    ? d1('SELECT id FROM cats').map((r) => r.id)
    : (has('--keep-cats') ? [] : intList('--cat'));

  console.log(`${APPLY ? 'DELETING' : 'Would delete'} ${sightings.length} sighting(s)` +
    `${catIds.length > 0 ? ` and ${catIds.length} cat(s)` : ''}:\n`);
  for (const s of sightings) {
    const when = new Date(s.seen_at).toISOString().slice(0, 16).replace('T', ' ');
    console.log(`  sighting ${s.id}  ${when}  cat=${s.cat_id ?? '—'}  ${s.note ?? ''}`);
  }
  if (catIds.length > 0) console.log(`  cats: ${catIds.join(', ')}`);

  if (!APPLY) {
    console.log('\nDry run. Pass --apply to actually delete.');
    return;
  }
  if (sightings.length === 0 && catIds.length === 0) {
    console.log('\nNothing matched.');
    return;
  }

  const purged = sightings;
  const hashes = [];
  for (const s of purged) {
    if (typeof s.photo_full === 'string') hashes.push(s.photo_full);
    if (typeof s.photo_thumb === 'string') hashes.push(s.photo_thumb);
  }

  /* Journal the hashes BEFORE the rows go. See migrations/002 — this is what lets
   * `npm run gc` finish the job after a crash without an API token. */
  const statements = [...journalForDelete(hashes, 'purge')];
  if (purged.length > 0) {
    statements.push(`DELETE FROM sightings WHERE id IN (${purged.map((s) => s.id).join(',')})`);
  }
  if (catIds.length > 0) {
    // Any sighting still pointing at a purged cat reverts to unidentified rather than
    // being destroyed as collateral — the same rule the app's delete-cat follows.
    statements.push(`UPDATE sightings SET cat_id = NULL WHERE cat_id IN (${catIds.join(',')})`);
    statements.push(`DELETE FROM cats WHERE id IN (${catIds.join(',')})`);
  }
  // Clients' ETags derive from data_version, so without this bump a phone holding a 304
  // keeps showing rows that no longer exist.
  statements.push(`UPDATE app_meta SET data_version = data_version + 1, updated_at = ${Date.now()} WHERE id = 1`);
  d1Many(statements);
  console.log('\nRows deleted.');

  const { deleted, failed } = sweepJournal();
  console.log(`${deleted} photo object(s) deleted.`);
  if (failed.length > 0) {
    console.error(`${failed.length} still queued — they stay in r2_gc_queue; run \`npm run gc\`.`);
    process.exitCode = 1;
  }

  const truth = bucketInfo();
  d1(`UPDATE app_meta SET r2_objects = ${truth.objects}, r2_bytes = ${truth.bytes}, `
     + `updated_at = ${Date.now()} WHERE id = 1`);
  console.log(`counters re-synced from the bucket: ${truth.objects} objects, ${truth.bytes} bytes`);
}

main();
