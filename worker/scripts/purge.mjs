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

import { d1, PREFIX, r2Delete } from './cf.mjs';

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
  if (purged.length > 0) {
    d1(`DELETE FROM sightings WHERE id IN (${purged.map((s) => s.id).join(',')})`);
  }
  if (catIds.length > 0) {
    // Any sighting still pointing at a purged cat reverts to unidentified rather than
    // being destroyed as collateral — the same rule the app's delete-cat follows.
    d1(`UPDATE sightings SET cat_id = NULL WHERE cat_id IN (${catIds.join(',')})`);
    d1(`DELETE FROM cats WHERE id IN (${catIds.join(',')})`);
  }
  // The clients' ETag is derived from data_version, so without this bump a phone holding
  // a 304 would keep showing rows that no longer exist.
  d1(`UPDATE app_meta SET data_version = data_version + 1, updated_at = ${Date.now()} WHERE id = 1`);
  console.log('\nRows deleted.');

  /* Reachability computed in SQL, deliberately — not by listing the bucket.
   *
   * Two reasons. Wrangler has no `r2 object list`, so listing would drag in a REST API
   * token this script otherwise does not need. And "delete the hashes I just deleted
   * rows for" would be WRONG: keys are content-addressed, so two sightings of the same
   * photo share one object, and eager deletion would blank a photo still in use.
   *
   * So: the candidate set is the hashes the purged rows referenced, minus everything
   * the surviving rows still reference. Orphans from older incidents are r2-reconcile's
   * job, not this script's. */
  const candidates = new Set();
  for (const s of purged) {
    if (typeof s.photo_full === 'string') candidates.add(s.photo_full);
    if (typeof s.photo_thumb === 'string') candidates.add(s.photo_thumb);
  }
  for (const row of d1('SELECT photo_full AS k FROM sightings UNION SELECT photo_thumb FROM sightings')) {
    candidates.delete(row.k);
  }

  console.log(`\n${candidates.size} photo object(s) no longer referenced.`);
  let freed = 0;
  const stranded = [];
  for (const hash of candidates) {
    // The rows are already gone, so a throw here would strand objects with nothing left
    // in D1 naming them. Report and continue; `npm run gc` is the sweeper.
    try {
      r2Delete(`${PREFIX}${hash}`);
      freed++;
      console.log(`  deleted ${PREFIX}${hash}`);
    } catch (err) {
      stranded.push(hash);
      console.error(`  STRANDED ${PREFIX}${hash}: ${err.message}`);
    }
  }
  if (stranded.length > 0) {
    console.error(`\n${stranded.length} object(s) stranded. Run \`npm run gc\` to sweep them.`);
    process.exitCode = 1;
  }

  if (freed > 0) {
    // Approximate, and knowingly so: the exact byte count needs a bucket listing. This
    // keeps the breaker's object count honest; `npm run reconcile` corrects the bytes.
    d1(`UPDATE app_meta SET r2_objects = MAX(0, r2_objects - ${freed}), ` +
       `updated_at = ${Date.now()} WHERE id = 1`);
    console.log('\nRun `npm run reconcile` to re-sync the exact byte counters.');
  }
}

main();
