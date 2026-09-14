/**
 * Reconcile the R2 cost breaker against reality, and sweep queued deletions.
 *
 *   npm run reconcile        # report only
 *   npm run reconcile -- --apply
 *   npm run gc               # sweep the deletion journal, then correct the counters
 *
 * NO API TOKEN. Everything here runs on the wrangler login you already have. That was
 * not true of the first version: it listed the bucket over the REST API, because
 * wrangler has no `r2 object list`, and so it demanded a hand-made token to clean up
 * your own data. Two changes removed the need:
 *
 *   - `r2 bucket info` gives the true object count and total size, which is all the
 *     COST BREAKER needs — it cares how much is stored, not which keys.
 *   - `r2_gc_queue` records every hash we are about to orphan BEFORE the rows naming it
 *     are deleted, so WHICH objects to delete is always answerable from D1.
 *
 * What is genuinely unknowable without a listing is an object that became orphaned
 * without going through our delete path — a put that landed after its D1 write failed.
 * That shows up here as a count mismatch, reported and never guessed at.
 */

import { bucketInfo, d1, sweepJournal } from './cf.mjs';

const args = new Set(process.argv.slice(2));
const GC = args.has('--gc');
const APPLY = args.has('--apply') || GC;

function main() {
  console.log(`Reconciling against the bucket${APPLY ? '' : '  (dry run)'}\n`);

  const meta = d1('SELECT r2_bytes, r2_objects, r2_reads_est FROM app_meta WHERE id = 1')[0];
  if (meta === undefined) throw new Error('app_meta row 1 missing — did migrations run?');

  const queued = d1('SELECT hash, queued_at, reason FROM r2_gc_queue');
  if (queued.length > 0) {
    console.log(`${queued.length} object(s) queued for deletion:`);
    for (const q of queued) {
      console.log(`  ${q.hash.slice(0, 12)}…  ${q.reason ?? ''}`);
    }
    console.log('');
  }

  if (GC && queued.length > 0) {
    const { deleted, failed } = sweepJournal();
    console.log(`deleted ${deleted}, ${failed.length} still queued\n`);
  } else if (queued.length > 0) {
    console.log('Pass --gc to delete them.\n');
  }

  const truth = bucketInfo();
  const referenced = d1(
    'SELECT COUNT(*) AS n FROM (SELECT photo_full AS k FROM sightings UNION SELECT photo_thumb FROM sightings)',
  )[0].n;

  const gb = (n) => (n / 1e9).toFixed(3);
  console.log(`stored objects   ${truth.objects}   (app_meta says ${meta.r2_objects})`);
  console.log(`stored bytes     ${gb(truth.bytes)} GB   (app_meta says ${gb(meta.r2_bytes)} GB)`);
  console.log(`referenced keys  ${referenced}`);
  console.log(`reads est/month  ${meta.r2_reads_est} (sampled; not verifiable from here)`);

  const unaccounted = truth.objects - referenced;
  if (unaccounted > 0) {
    // Not auto-fixed, and not guessable: identifying them needs a bucket listing
    // wrangler cannot do. Naming the number is the honest half of the answer.
    console.log(`\n${unaccounted} object(s) UNACCOUNTED FOR — stored but referenced by no row.`);
    console.log('These predate the deletion journal, or a put landed after its D1 write');
    console.log('failed. They cost storage but nothing else. To identify them you need a');
    console.log('bucket listing, which wrangler cannot do; the R2 dashboard can.');
  } else if (unaccounted < 0) {
    console.log(`\n${-unaccounted} referenced key(s) are NOT in the bucket — a sighting has`);
    console.log('lost its photo. Investigate; this script will not "fix" it by deleting rows.');
  }

  if (!APPLY) {
    console.log('\nDry run. Pass --apply to correct app_meta.');
    return;
  }
  d1(`UPDATE app_meta SET r2_bytes = ${truth.bytes}, r2_objects = ${truth.objects}, `
     + `updated_at = ${Date.now()} WHERE id = 1`);
  console.log(`\napp_meta corrected to ${truth.objects} objects / ${gb(truth.bytes)} GB`);
}

main();
