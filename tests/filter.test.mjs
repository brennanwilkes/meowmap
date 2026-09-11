// Coat filtering on the map.
//   node tests/filter.test.mjs
//
// The bug worth guarding: filtering the PINS but not the TERRITORY, which draws a
// shaded "Mochi's turf" blob with nothing inside it.

import assert from 'node:assert';
import {
  filterCats, filterSightings, filterSummary, matchesCoat,
} from '../frontend/app/filter.js';

let pass = 0;
const check = (name, fn) => {
  try { fn(); pass++; }
  catch (e) { console.error(`FAIL  ${name}\n      ${e.message}`); process.exitCode = 1; }
};

const s = (id, ...coat) => ({ id, lat: 48.4, lon: -123.3, seenAt: 0, coat });
const none = new Set();

check('no filter shows everything, including untagged sightings', () => {
  const all = [s(1, 'orange'), s(2)];
  assert.strictEqual(filterSightings(all, none), all, 'must be the same array, not a copy');
  assert.strictEqual(matchesCoat(s(2), none), true);
});

check('multi-select is OR, so each extra chip can only show MORE', () => {
  // Monotonicity is the property that makes the filter predictable while walking.
  const all = [s(1, 'orange'), s(2, 'black'), s(3, 'calico')];
  const one = filterSightings(all, new Set(['orange']));
  const two = filterSightings(all, new Set(['orange', 'black']));
  assert.strictEqual(one.length, 1);
  assert.strictEqual(two.length, 2);
  for (const x of one) assert.ok(two.includes(x), 'adding a chip must never remove a result');
});

check('a multi-tag sighting matches on ANY of its tags', () => {
  assert.strictEqual(matchesCoat(s(1, 'orange', 'tabby'), new Set(['tabby'])), true);
});

check('an untagged sighting is hidden once a filter is on', () => {
  // It has to be: "show me the orange ones" cannot honestly include unknowns.
  assert.strictEqual(matchesCoat(s(1), new Set(['orange'])), false);
});

check('a sighting with a missing coat field does not throw', () => {
  assert.strictEqual(matchesCoat({ id: 1 }, new Set(['orange'])), false);
  assert.strictEqual(matchesCoat({ id: 1, coat: null }, none), true);
});

/* ── the territory half ────────────────────────────────────────────────── */

check('TERRITORY IS FILTERED TOO — a blob is never drawn around hidden points', () => {
  const cats = [{ id: 1, name: 'Mochi', sightings: [s(1, 'orange'), s(2, 'black'), s(3, 'orange')] }];
  const out = filterCats(cats, new Set(['orange']));
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].sightings.length, 2, 'the black sighting must be gone');
  assert.deepStrictEqual(out[0].sightings.map((x) => x.id), [1, 3]);
});

check('a cat with nothing matching disappears rather than becoming an empty blob', () => {
  const cats = [{ id: 1, sightings: [s(1, 'black')] }];
  assert.deepStrictEqual(filterCats(cats, new Set(['orange'])), []);
});

check('filterCats does not mutate the input', () => {
  const cats = [{ id: 1, sightings: [s(1, 'orange'), s(2, 'black')] }];
  filterCats(cats, new Set(['orange']));
  assert.strictEqual(cats[0].sightings.length, 2, 'the store must be left alone');
});

check('the summary says what is hidden, so a filter is never invisible', () => {
  assert.strictEqual(filterSummary(none, 5, 5), null);
  assert.match(filterSummary(new Set(['orange']), 2, 7), /showing 2 of 7/);
  assert.match(filterSummary(new Set(['orange', 'black']), 3, 7), /orange or black/);
  assert.match(filterSummary(new Set(['orange', 'black', 'grey']), 3, 7), /orange, black or grey/);
});

console.log(`filter: ${pass} checks passed`);
