// Territory blob geometry. Local only, no framework:  node tests/turf.test.mjs
import assert from 'node:assert';
import { TURF_PAD_M, shouldDrawTurf, turfRing } from '../frontend/app/turf.js';
import { distanceM } from '../frontend/app/suggest.js';

let pass = 0;
const check = (name, fn) => {
  try { fn(); pass++; }
  catch (e) { console.error(`FAIL  ${name}\n      ${e.message}`); process.exitCode = 1; }
};

const MOCHI = [
  [48.4278, -123.3535],
  [48.4271, -123.3498],
  [48.4262, -123.3521],
];

check('a turf starts at the second sighting', () => {
  assert.strictEqual(shouldDrawTurf(1), false);
  assert.strictEqual(shouldDrawTurf(2), true);
  assert.strictEqual(shouldDrawTurf(3), true);
});

check('two points still make a sane ring', () => {
  const { ring } = turfRing([[48.4284, -123.3656], [48.4291, -123.3640]]);
  assert.ok(ring.length > 8);
  for (const [lat, lon] of ring) {
    assert.ok(Number.isFinite(lat) && Number.isFinite(lon));
  }
});

check('the ring encloses every sighting with room to spare', () => {
  const { ring, centre } = turfRing(MOCHI);
  for (const [plat, plon] of MOCHI) {
    // The point must be strictly inside: find the ring vertex in its direction and
    // confirm the ring is further from the centre than the point is.
    const pd = distanceM(centre[0], centre[1], plat, plon);
    let nearestRing = Infinity;
    for (const [rlat, rlon] of ring) {
      const bearingGap = Math.abs(
        Math.atan2(rlat - centre[0], rlon - centre[1]) -
        Math.atan2(plat - centre[0], plon - centre[1]),
      );
      if (bearingGap < 0.2) {
        nearestRing = Math.min(nearestRing, distanceM(centre[0], centre[1], rlat, rlon));
      }
    }
    assert.ok(nearestRing > pd, `sighting at ${plat},${plon} is outside its own turf`);
  }
});

check('padding is roughly TURF_PAD_M beyond the outermost sighting', () => {
  const { ring, centre } = turfRing(MOCHI);
  const maxPt = Math.max(...MOCHI.map((p) => distanceM(centre[0], centre[1], p[0], p[1])));
  const maxRing = Math.max(...ring.map((p) => distanceM(centre[0], centre[1], p[0], p[1])));
  const overshoot = maxRing - maxPt;
  // The wobble is +/-8%, so allow generous slack — this only asserts the pad is applied
  // and is in the right order of magnitude, not an exact value.
  assert.ok(overshoot > TURF_PAD_M * 0.5 && overshoot < TURF_PAD_M * 2.5,
    `overshoot ${overshoot.toFixed(0)} m is not near the ${TURF_PAD_M} m pad`);
});

check('the shape is deterministic — it must not shimmer between renders', () => {
  const a = turfRing(MOCHI);
  const b = turfRing(MOCHI);
  assert.deepStrictEqual(a.ring, b.ring);
});

check('nearly collinear sightings do not degenerate into a sliver', () => {
  // The case that killed the convex-hull approach: three points almost in a line.
  const line = [[48.4260, -123.3500], [48.4265, -123.3500], [48.4270, -123.35001]];
  const { ring, centre } = turfRing(line);
  const radii = ring.map((p) => distanceM(centre[0], centre[1], p[0], p[1]));
  assert.ok(Math.min(...radii) > TURF_PAD_M * 0.5,
    `narrowest radius ${Math.min(...radii).toFixed(0)} m — the blob collapsed`);
});

check('a single sighting yields a rough circle', () => {
  const { ring, centre } = turfRing([[48.4266, -123.3505]]);
  const radii = ring.map((p) => distanceM(centre[0], centre[1], p[0], p[1]));
  const min = Math.min(...radii);
  const max = Math.max(...radii);
  assert.ok(max / min < 1.35, `too eccentric for one point: ${min.toFixed(0)}..${max.toFixed(0)}`);
});

check('the ring closes on itself', () => {
  const { ring } = turfRing(MOCHI);
  assert.strictEqual(ring.length, 44);
  const gap = distanceM(ring[0][0], ring[0][1], ring[43][0], ring[43][1]);
  const span = distanceM(ring[0][0], ring[0][1], ring[22][0], ring[22][1]);
  assert.ok(gap < span, 'first and last vertices should be adjacent, not opposite');
});

check('no points throws rather than returning something empty', () => {
  assert.throws(() => turfRing([]), /at least one point/);
});

console.log(`turf: ${pass} checks passed`);
