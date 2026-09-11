// The photo pipeline's pure half: geometry and location resolution.
//   node tests/pipeline.test.mjs
//
// Canvas and createImageBitmap do not exist in Node, so the encode path is verified on
// the device. What IS tested here is every decision that can silently produce a wrong
// pin or a wrong date — which is where this app's damage lives.

import assert from 'node:assert';
import { fitLongEdge, halvingPlan } from '../frontend/app/resize.js';
import {
  FRESH_PHOTO_WINDOW_MS, LOCATION_SOURCE, resolveLocation, resolveSeenAt,
} from '../frontend/app/pipeline.js';
import { FULL_LONG_EDGE, GEO_POOR_ACCURACY_M, THUMB_LONG_EDGE } from '../frontend/config.js';

let pass = 0;
const check = (name, fn) => {
  try { fn(); pass++; }
  catch (e) { console.error(`FAIL  ${name}\n      ${e.message}`); process.exitCode = 1; }
};

const NOW = Date.UTC(2026, 8, 11, 12, 0, 0);
const meta = (over = {}) => ({
  container: 'jpeg',
  truncated: false,
  pixelWidth: 4032,
  pixelHeight: 3024,
  hasExif: true,
  orientation: 6,
  dateTimeOriginal: null,
  offsetTimeOriginal: null,
  gpsDateTimeUtc: null,
  gps: null,
  ...over,
});
const fix = (accuracyM = 20) => ({ lat: 48.4298, lon: -123.3620, accuracyM });

/* ── geometry ──────────────────────────────────────────────────────────── */

check('fitLongEdge scales the long edge and preserves the aspect ratio', () => {
  const r = fitLongEdge(4032, 3024, FULL_LONG_EDGE);
  assert.strictEqual(r.w, 2048);
  assert.strictEqual(r.h, 1536);
});

check('fitLongEdge handles portrait, where the long edge is the height', () => {
  const r = fitLongEdge(3024, 4032, FULL_LONG_EDGE);
  assert.strictEqual(r.h, 2048);
  assert.strictEqual(r.w, 1536);
});

check('fitLongEdge NEVER upscales — a small photo stays small', () => {
  const r = fitLongEdge(300, 200, FULL_LONG_EDGE);
  assert.deepStrictEqual(r, { w: 300, h: 200 });
});

check('fitLongEdge never yields a zero dimension', () => {
  const r = fitLongEdge(4000, 3, THUMB_LONG_EDGE);
  assert.ok(r.h >= 1, `height collapsed to ${r.h}`);
});

check('halvingPlan halves down and takes the remainder in one final step', () => {
  const plan = halvingPlan(4032, 3024, 2048, 1536);
  assert.deepStrictEqual(plan.at(-1), { w: 2048, h: 1536 }, 'must end exactly on target');
  for (const s of plan) assert.ok(s.w >= 2048 && s.h >= 1536, 'never undershoots mid-plan');
});

check('halvingPlan never reduces by more than 2x in any single step', () => {
  // The whole reason the plan exists: Safari's scaler aliases badly on a big reduction.
  const plan = halvingPlan(4032, 3024, 480, 360);
  let w = 4032;
  for (const s of plan) {
    assert.ok(w / s.w <= 2.0001, `step reduced by ${(w / s.w).toFixed(2)}x`);
    w = s.w;
  }
  assert.strictEqual(plan.at(-1).w, 480);
});

check('halvingPlan is a single step when no halving is needed', () => {
  assert.deepStrictEqual(halvingPlan(600, 400, 480, 320), [{ w: 480, h: 320 }]);
});

/* ── location resolution ───────────────────────────────────────────────── */

check('EXIF GPS wins outright, and carries its own accuracy', () => {
  const r = resolveLocation(
    meta({ gps: { lat: 48.42985, lon: -123.36201, accuracyM: 9.98 } }), fix(), false, NOW,
  );
  assert.strictEqual(r.source, LOCATION_SOURCE.exif);
  assert.strictEqual(r.lat, 48.42985);
  // 9.98 rounded: the photo's accuracy, not the device fix's 20. See the whole-metres
  // check below for why it is rounded at all.
  assert.strictEqual(r.accuracyM, 10);
  assert.strictEqual(r.needsManual, false);
});

check('EXIF GPS beats the device fix even when the device fix is available', () => {
  // Measured: the EXIF fix was 9.98 m against the live fix's 20 m. The photo knows better.
  const r = resolveLocation(
    meta({ gps: { lat: 1, lon: 2, accuracyM: null } }), fix(5), false, NOW,
  );
  assert.strictEqual(r.lat, 1);
  assert.strictEqual(r.source, LOCATION_SOURCE.exif);
});

check('the camera path uses the device fix — iOS strips its GPS by design', () => {
  const r = resolveLocation(meta({ orientation: 6 }), fix(20), true, NOW);
  assert.strictEqual(r.source, LOCATION_SOURCE.device);
  assert.strictEqual(r.needsManual, false);
  assert.strictEqual(r.notice, null, 'no notice needed: this is the intended source');
});

check('a POOR device fix pre-opens correction rather than being quietly accepted', () => {
  const r = resolveLocation(meta(), fix(GEO_POOR_ACCURACY_M + 1), true, NOW);
  assert.strictEqual(r.needsManual, true);
  assert.match(r.notice, /accurate to about/);
  assert.ok(r.lat !== null, 'but the fix is still offered as a starting point');
});

check('a fresh library photo may borrow the device fix, and SAYS SO', () => {
  const takenAt = NOW - 3 * 60_000;
  const r = resolveLocation(meta({ gpsDateTimeUtc: new Date(takenAt).toISOString() }), fix(), false, NOW);
  assert.strictEqual(r.source, LOCATION_SOURCE.device);
  assert.match(r.notice, /3 minutes ago/, 'a silent substitution would be a lie');
});

check('an OLD library photo never borrows the device fix', () => {
  // The failure this prevents: a photo taken last week pinned to where she is standing.
  const takenAt = NOW - FRESH_PHOTO_WINDOW_MS - 1;
  const r = resolveLocation(meta({ gpsDateTimeUtc: new Date(takenAt).toISOString() }), fix(), false, NOW);
  assert.strictEqual(r.source, LOCATION_SOURCE.manual);
  assert.strictEqual(r.lat, null, 'NEVER write coordinates we do not believe');
  assert.strictEqual(r.needsManual, true);
});

check('an undated photo with no GPS goes straight to manual', () => {
  const r = resolveLocation(meta(), fix(), false, NOW);
  assert.strictEqual(r.source, LOCATION_SOURCE.manual);
  assert.strictEqual(r.lat, null);
});

check('no GPS and no device fix is manual, with a reason that fits the path', () => {
  const lib = resolveLocation(meta(), null, false, NOW);
  const cam = resolveLocation(meta(), null, true, NOW);
  assert.strictEqual(lib.source, LOCATION_SOURCE.manual);
  assert.strictEqual(cam.source, LOCATION_SOURCE.manual);
  assert.match(lib.notice, /no location saved in it/);
  assert.match(cam.notice, /could not get a location/);
});

check('the nag card is gone — no resolution mentions the picker Location toggle', () => {
  // The probe falsified its premise: library photos DID carry GPS untouched. See
  // docs/BUILD-STATUS.md. This test is what stops it being reintroduced by habit.
  for (const r of [
    resolveLocation(meta(), null, false, NOW),
    resolveLocation(meta(), fix(), false, NOW),
  ]) {
    assert.doesNotMatch(r.notice, /Options|toggle|settings/i, `leaked a nag: ${r.notice}`);
  }
});

check('accuracy is WHOLE METRES — the Worker rejects a fraction with a 400', () => {
  // Found while wiring the sighting editor. `int()` on the Worker throws on 9.98, the
  // outbox classifies 400 as TERMINAL, so every single upload would have gone straight
  // to `failed`. Both real sources are floats: EXIF gave 9.98 and coords.accuracy is a
  // double. This is the regression guard.
  const fromExif = resolveLocation(
    meta({ gps: { lat: 48.4, lon: -123.3, accuracyM: 9.98 } }), null, false, NOW,
  );
  assert.strictEqual(fromExif.accuracyM, 10);
  assert.ok(Number.isInteger(fromExif.accuracyM));

  const fromDevice = resolveLocation(meta(), fix(20.472), true, NOW);
  assert.strictEqual(fromDevice.accuracyM, 20);
  assert.ok(Number.isInteger(fromDevice.accuracyM));
});

check('a missing accuracy stays null rather than becoming 0', () => {
  // 0 metres would be a claim of perfect precision, which is a lie, not a default.
  const r = resolveLocation(
    meta({ gps: { lat: 48.4, lon: -123.3, accuracyM: null } }), null, false, NOW,
  );
  assert.strictEqual(r.accuracyM, null);
});

/* ── dates ─────────────────────────────────────────────────────────────── */

check('seenAt prefers the photo capture time', () => {
  const takenAt = NOW - 86_400_000;
  assert.strictEqual(resolveSeenAt(meta({ gpsDateTimeUtc: new Date(takenAt).toISOString() }), NOW), takenAt);
});

check('seenAt falls back to now when the photo has no date', () => {
  assert.strictEqual(resolveSeenAt(meta(), NOW), NOW);
});

check('a camera clock claiming the future or 1970 is rejected, not honoured', () => {
  const future = meta({ gpsDateTimeUtc: new Date(NOW + 10 * 86_400_000).toISOString() });
  const ancient = meta({ gpsDateTimeUtc: '1980-01-01T00:00:00Z' });
  assert.strictEqual(resolveSeenAt(future, NOW), NOW);
  assert.strictEqual(resolveSeenAt(ancient, NOW), NOW);
});

console.log(`pipeline: ${pass} checks passed`);
