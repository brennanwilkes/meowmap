/**
 * Reconcile the R2 cost breaker against reality, and report orphaned objects.
 *
 * Why this has to exist: r2_bytes/r2_objects are maintained incrementally by the Worker
 * and can drift (a put that succeeded after the D1 batch failed, a manual deletion), and
 * r2_reads_est is SAMPLED 1-in-100 so it is an estimate by construction. Since those
 * counters are the only thing standing between this app and an R2 bill, an unverified
 * estimate is not good enough on its own.
 *
 *   node scripts/r2-reconcile.mjs              # report only (default)
 *   node scripts/r2-reconcile.mjs --apply      # also correct app_meta
 *   node scripts/r2-reconcile.mjs --gc         # additionally DELETE unreferenced objects
 *
 * ORPHAN SAFETY: keys are content-addressed, so two sightings can point at one object.
 * Deletion is therefore reachability-based over the WHOLE table — including soft-deleted
 * tombstones, which deliberately pin their bytes so undelete stays free. Never delete an
 * object on the request path; a broken photo is cached `immutable` for a year and the
 * damage would stay invisible for weeks.
 */

import { BUCKET, DB_NAME, d1, PREFIX, r2Delete, r2List } from './cf.mjs';

const args = new Set(process.argv.slice(2));
const APPLY = args.has('--apply') || args.has('--gc');
const GC = args.has('--gc');

function main() {
  console.log(`Reconciling ${BUCKET} against ${DB_NAME}${APPLY ? '' : '  (dry run)'}\n`);

  const referenced = new Set();
  for (const row of d1(
    'SELECT photo_full AS k FROM sightings UNION SELECT photo_thumb FROM sightings',
  )) {
    if (typeof row.k === 'string' && row.k !== '') referenced.add(`${PREFIX}${row.k}`);
  }

  const stored = r2List();
  const storedKeys = new Set(stored.map((o) => o.key));
  const trueBytes = stored.reduce((s, o) => s + o.size, 0);
  const trueObjects = stored.length;

  const meta = d1('SELECT r2_bytes, r2_objects, r2_reads_est FROM app_meta WHERE id = 1')[0];
  if (meta === undefined) throw new Error('app_meta row 1 missing — did migrations run?');

  const orphans = stored.filter((o) => !referenced.has(o.key));
  // The scary direction: a row pointing at a photo that is not there.
  const missing = [...referenced].filter((k) => !storedKeys.has(k));

  const gb = (n) => (n / 1e9).toFixed(3);
  console.log(`stored objects   ${trueObjects}   (app_meta says ${meta.r2_objects})`);
  console.log(`stored bytes     ${gb(trueBytes)} GB   (app_meta says ${gb(meta.r2_bytes)} GB)`);
  console.log(`drift            ${gb(trueBytes - meta.r2_bytes)} GB`);
  console.log(`orphaned         ${orphans.length} objects, ${gb(orphans.reduce((s, o) => s + o.size, 0))} GB`);
  console.log(`MISSING          ${missing.length} referenced objects not in the bucket`);
  console.log(`reads est/month  ${meta.r2_reads_est} (sampled; not verifiable from here)\n`);

  if (missing.length > 0) {
    // Never auto-fix this. A missing object means a sighting has lost its photo, and the
    // right response is a human deciding what to do, not a script tidying up.
    console.log('MISSING KEYS (investigate, do not auto-delete the rows):');
    for (const k of missing.slice(0, 25)) console.log(`  ${k}`);
    if (missing.length > 25) console.log(`  … and ${missing.length - 25} more`);
    console.log('');
  }

  if (GC && orphans.length > 0) {
    console.log(`Deleting ${orphans.length} orphaned objects (DeleteObject is free)…`);
    for (const o of orphans) r2Delete(o.key);
  } else if (orphans.length > 0) {
    console.log(`Pass --gc to delete ${orphans.length} orphans. Sample:`);
    for (const o of orphans.slice(0, 10)) console.log(`  ${o.key}  ${o.size}B`);
    console.log('');
  }

  if (APPLY) {
    const finalObjects = GC ? trueObjects - orphans.length : trueObjects;
    const finalBytes = GC ? trueBytes - orphans.reduce((s, o) => s + o.size, 0) : trueBytes;
    d1(`UPDATE app_meta SET r2_bytes = ${finalBytes}, r2_objects = ${finalObjects}, ` +
       `updated_at = ${Date.now()} WHERE id = 1`);
    console.log(`app_meta corrected to ${finalObjects} objects / ${gb(finalBytes)} GB`);
  } else {
    console.log('Dry run. Pass --apply to correct app_meta.');
  }
}

main();
