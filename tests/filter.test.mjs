// Map filtering by coat / size / petted.
//   node tests/filter.test.mjs
//
// Two properties carry the weight: OR-within-a-group stays monotone (an extra chip can
// only reveal more), and TERRITORY is filtered alongside pins — otherwise a turf blob is
// drawn around points that are not on the map.

import assert from 'node:assert';
import {
  emptyFilter, filterCats, filterSightings, isActive, matches, toggle,
} from '../frontend/app/filter.js';

let pass = 0;
const check = (name, fn) => {
  try { fn(); pass++; }
  catch (e) { console.error(`FAIL  ${name}\n      ${e.message}`); process.exitCode = 1; }
};

const s = (id, over = {}) => ({
  id, lat: 48.4, lon: -123.3, seenAt: 0, coat: [], size: null, petted: null, ...over,
});
const f = (over = {}) => {
  const base = emptyFilter();
  for (const [k, v] of Object.entries(over)) base[k] = new Set(v);
  return base;
};

check('an untouched filter shows everything, untagged included', () => {
  const all = [s(1, { coat: ['orange'] }), s(2)];
  assert.strictEqual(isActive(emptyFilter()), false);
  assert.strictEqual(filterSightings(all, emptyFilter()), all, 'same array, not a copy');
  assert.strictEqual(matches(s(2), emptyFilter()), true);
});

check('WITHIN a group it is OR, so each extra chip can only show MORE', () => {
  const all = [s(1, { coat: ['orange'] }), s(2, { coat: ['black'] }), s(3, { coat: ['calico'] })];
  const one = filterSightings(all, f({ coat: ['orange'] }));
  const two = filterSightings(all, f({ coat: ['orange', 'black'] }));
  assert.strictEqual(one.length, 1);
  assert.strictEqual(two.length, 2);
  for (const x of one) assert.ok(two.includes(x), 'adding a chip must never remove a result');
});

check('ACROSS groups it is AND, which is what makes a second group useful', () => {
  const orangeChonk = s(1, { coat: ['orange'], size: 'chonk' });
  const orangeKitten = s(2, { coat: ['orange'], size: 'kitten' });
  const blackChonk = s(3, { coat: ['black'], size: 'chonk' });
  const out = filterSightings([orangeChonk, orangeKitten, blackChonk], f({ coat: ['orange'], size: ['chonk'] }));
  assert.deepStrictEqual(out.map((x) => x.id), [1]);
});

check('a multi-tag coat matches on ANY of its tags', () => {
  assert.strictEqual(matches(s(1, { coat: ['orange', 'tabby'] }), f({ coat: ['tabby'] })), true);
});

check('size and petted are single-valued and match exactly', () => {
  assert.strictEqual(matches(s(1, { size: 'chonk' }), f({ size: ['chonk'] })), true);
  assert.strictEqual(matches(s(1, { size: 'kitten' }), f({ size: ['chonk'] })), false);
  assert.strictEqual(matches(s(1, { petted: 'yes' }), f({ petted: ['yes'] })), true);
});

check('an untagged sighting is hidden by whichever group is active', () => {
  assert.strictEqual(matches(s(1), f({ coat: ['orange'] })), false);
  assert.strictEqual(matches(s(1, { coat: ['orange'] }), f({ size: ['chonk'] })), false,
    'tagged for coat but not size is still hidden by an active size filter');
});

check('a missing field does not throw', () => {
  assert.strictEqual(matches({ id: 1 }, f({ coat: ['orange'] })), false);
  assert.strictEqual(matches({ id: 1, coat: null }, emptyFilter()), true);
});

check('toggle adds then removes', () => {
  const t = emptyFilter();
  toggle(t, 'coat', 'orange');
  assert.strictEqual(isActive(t), true);
  toggle(t, 'coat', 'orange');
  assert.strictEqual(isActive(t), false);
});

/* ── the territory half ────────────────────────────────────────────────── */

check('TERRITORY IS FILTERED TOO — a blob is never drawn around hidden points', () => {
  const cats = [{
    id: 1,
    sightings: [s(1, { coat: ['orange'] }), s(2, { coat: ['black'] }), s(3, { coat: ['orange'] })],
  }];
  const out = filterCats(cats, f({ coat: ['orange'] }));
  assert.strictEqual(out.length, 1);
  assert.deepStrictEqual(out[0].sightings.map((x) => x.id), [1, 3]);
});

check('a cat with nothing matching disappears rather than becoming an empty blob', () => {
  const cats = [{ id: 1, sightings: [s(1, { coat: ['black'] })] }];
  assert.deepStrictEqual(filterCats(cats, f({ coat: ['orange'] })), []);
});

check('filterCats does not mutate the store', () => {
  const cats = [{ id: 1, sightings: [s(1, { coat: ['orange'] }), s(2, { coat: ['black'] })] }];
  filterCats(cats, f({ coat: ['orange'] }));
  assert.strictEqual(cats[0].sightings.length, 2);
});

console.log(`filter: ${pass} checks passed`);
