// Link-suggestion ranking. Local only, no framework:  node tests/suggest.test.mjs
//
// Imports the REAL module so the test can never drift from what ships.
import assert from 'node:assert';
import {
  MAX_DISTANCE_M, coatOverlap, distanceM, reasonText, scoreCandidate, suggestCats,
} from '../frontend/app/suggest.js';

let pass = 0;
const check = (name, fn) => {
  try { fn(); pass++; }
  catch (e) { console.error(`FAIL  ${name}\n      ${e.message}`); process.exitCode = 1; }
};

const NOW = Date.UTC(2026, 8, 10);
const DAY = 86_400_000;
const HERE = { lat: 48.4266, lon: -123.3505, coat: ['orange', 'tabby'] };

/** Offset a point by n metres north / east of HERE. */
function at(northM, eastM, extra = {}) {
  return {
    lat: HERE.lat + northM / 111_320,
    lon: HERE.lon + eastM / (111_320 * Math.cos(HERE.lat * Math.PI / 180)),
    seenAt: NOW - DAY,
    coat: [],
    ...extra,
  };
}
const cat = (id, sightings) => ({ id, sightings });

check('distanceM is accurate enough at neighbourhood scale', () => {
  const p = at(100, 0);
  const d = distanceM(HERE.lat, HERE.lon, p.lat, p.lon);
  assert.ok(Math.abs(d - 100) < 1, `expected ~100 m, got ${d}`);
});

check('250 m is a hard cut, not a penalty', () => {
  const far = cat(1, [at(0, MAX_DISTANCE_M + 20)]);
  assert.strictEqual(scoreCandidate(HERE, far, NOW), null);
  const near = cat(2, [at(0, MAX_DISTANCE_M - 20)]);
  assert.notStrictEqual(scoreCandidate(HERE, near, NOW), null);
});

check('a closer-older cat outranks a farther-newer one', () => {
  const closeOld = cat(1, [at(0, 20, { seenAt: NOW - 7 * DAY })]);
  const farNew = cat(2, [at(0, 200, { seenAt: NOW - DAY })]);
  const [best] = suggestCats(HERE, [farNew, closeOld], NOW);
  assert.strictEqual(best.catId, 1, 'distance must dominate recency');
});

check('a coat mismatch demotes but does not exclude', () => {
  const mismatch = cat(1, [at(0, 30, { coat: ['black', 'tuxedo'] })]);
  const match = cat(2, [at(0, 60, { coat: ['orange', 'tabby'] })]);
  const out = suggestCats(HERE, [mismatch, match], NOW);
  assert.strictEqual(out.length, 2, 'mismatch must still be offered');
  assert.strictEqual(out[0].catId, 2, 'matching coat should win despite being farther');
});

check('an untagged sighting still ranks sanely — the common case', () => {
  const untagged = { lat: HERE.lat, lon: HERE.lon, coat: [] };
  const near = cat(1, [at(0, 25, { coat: ['black'] })]);
  const far = cat(2, [at(0, 200, { coat: ['orange', 'tabby'] })]);
  const out = suggestCats(untagged, [far, near], NOW);
  assert.strictEqual(out[0].catId, 1, 'with no tags, distance should decide');
  assert.strictEqual(out[0].coatOverlap, null, 'no tags means no overlap signal, not zero');
});

check('coatOverlap distinguishes absent from disjoint', () => {
  assert.strictEqual(coatOverlap([], ['black']), null);
  assert.strictEqual(coatOverlap(['orange'], []), null);
  assert.strictEqual(coatOverlap(['orange'], ['black']), 0);
  assert.strictEqual(coatOverlap(['orange', 'tabby'], ['orange', 'tabby']), 1);
});

check('at most three suggestions, best first', () => {
  const cats = [1, 2, 3, 4, 5].map((i) => cat(i, [at(0, i * 10)]));
  const out = suggestCats(HERE, cats, NOW);
  assert.strictEqual(out.length, 3);
  assert.deepStrictEqual(out.map((s) => s.catId), [1, 2, 3]);
});

check('ranking is deterministic for identical candidates', () => {
  const a = cat(7, [at(0, 40)]);
  const b = cat(3, [at(0, 40)]);
  const first = suggestCats(HERE, [a, b], NOW).map((s) => s.catId);
  const second = suggestCats(HERE, [b, a], NOW).map((s) => s.catId);
  assert.deepStrictEqual(first, second, 'input order must not change output');
  assert.deepStrictEqual(first, [3, 7], 'ties break on lower id');
});

check('a cat with no sightings is not a candidate', () => {
  assert.strictEqual(scoreCandidate(HERE, cat(1, []), NOW), null);
});

check('reasonText reads like a person wrote it', () => {
  const s = { nearestM: 3, lastSeenAt: NOW - DAY };
  assert.strictEqual(reasonText(s, NOW), 'right here, yesterday');
  assert.strictEqual(
    reasonText({ nearestM: 40, lastSeenAt: NOW - 3 * DAY }, NOW),
    '40 metres away, 3 days ago',
  );
});

console.log(`suggest: ${pass} checks passed`);
