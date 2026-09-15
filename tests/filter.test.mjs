// Map filtering by coat / size / petted.
//   node tests/filter.test.mjs
//
// THE TAGS NO LONGER LIVE IN ONE PLACE. Coat and size are the CAT's (migration 003);
// petted is the SIGHTING's (004), because it is stamped on the photograph. So coat and
// size take a whole cat in or out, while petted drops individual photos and can leave a
// cat with none — at which point the cat has to go too, or a turf blob gets drawn around
// points that are not on the map.
//
// Three properties carry the weight: OR-within-a-group stays monotone (an extra chip can
// only reveal more), a PENDING upload is filtered on the tags she typed because its cat
// does not exist until the Worker mints one, and filterCats never mutates the store.

import assert from 'node:assert';
import {
  emptyFilter, filterCats, filterSightings, isActive, matches, toggle,
} from '../frontend/app/filter.js';

let pass = 0;
const check = (name, fn) => {
  try { fn(); pass++; }
  catch (e) { console.error(`FAIL  ${name}\n      ${e.message}`); process.exitCode = 1; }
};

/** A cat: what the animal IS. */
const cat = (id, over = {}) => ({ id, name: null, coat: [], size: null, ...over });
/** A sighting: where, when, and what happened on that encounter. */
const s = (id, catId, over = {}) => ({ id, catId, lat: 48.4, lon: -123.3, seenAt: 0, petted: null, ...over });
const index = (...cats) => new Map(cats.map((c) => [c.id, c]));
const f = (over = {}) => {
  const base = emptyFilter();
  for (const [k, v] of Object.entries(over)) base[k] = new Set(v);
  return base;
};

check('an untouched filter shows everything, untagged included', () => {
  const all = [s(1, 1), s(2, 2)];
  assert.strictEqual(isActive(emptyFilter()), false);
  assert.strictEqual(filterSightings(all, index(), emptyFilter()), all, 'same array, not a copy');
  assert.strictEqual(matches(s(1, 2), cat(2), emptyFilter()), true);
});

check('WITHIN a group it is OR, so each extra chip can only show MORE', () => {
  const cats = index(
    cat(1, { coat: ['orange'] }), cat(2, { coat: ['black'] }), cat(3, { coat: ['calico'] }),
  );
  const all = [s(1, 1), s(2, 2), s(3, 3)];
  const one = filterSightings(all, cats, f({ coat: ['orange'] }));
  const two = filterSightings(all, cats, f({ coat: ['orange', 'black'] }));
  assert.strictEqual(one.length, 1);
  assert.strictEqual(two.length, 2);
  for (const x of one) assert.ok(two.includes(x), 'adding a chip must never remove a result');
});

check('ACROSS groups it is AND, which is what makes a second group useful', () => {
  const cats = index(
    cat(1, { coat: ['orange'], size: 'chonk' }),
    cat(2, { coat: ['orange'], size: 'kitten' }),
    cat(3, { coat: ['black'], size: 'chonk' }),
  );
  const out = filterSightings([s(1, 1), s(2, 2), s(3, 3)], cats, f({ coat: ['orange'], size: ['chonk'] }));
  assert.deepStrictEqual(out.map((x) => x.id), [1]);
});

check('a multi-tag coat matches on ANY of its tags', () => {
  assert.strictEqual(matches(s(1, 1), cat(1, { coat: ['orange', 'tabby'] }), f({ coat: ['tabby'] })), true);
});

check('size is the cat’s and matches exactly', () => {
  assert.strictEqual(matches(s(1, 1), cat(1, { size: 'chonk' }), f({ size: ['chonk'] })), true);
  assert.strictEqual(matches(s(1, 1), cat(1, { size: 'kitten' }), f({ size: ['chonk'] })), false);
});

check('PETTED IS THE SIGHTING’S, NOT THE CAT’S', () => {
  // The whole point of migration 004: two photos of one cat can disagree, because on one
  // of those days she managed it and on the other she did not.
  const c = cat(1, { coat: ['orange'] });
  assert.strictEqual(matches(s(1, 1, { petted: 'yes' }), c, f({ petted: ['yes'] })), true);
  assert.strictEqual(matches(s(2, 1, { petted: 'no' }), c, f({ petted: ['yes'] })), false);
});

check('an untagged cat is hidden by whichever group is active', () => {
  assert.strictEqual(matches(s(1, 1), cat(1), f({ coat: ['orange'] })), false);
  assert.strictEqual(matches(s(1, 1), cat(1, { coat: ['orange'] }), f({ size: ['chonk'] })), false,
    'tagged for coat but not size is still hidden by an active size filter');
});

check('a missing field does not throw', () => {
  assert.strictEqual(matches(s(1, 1), { id: 1 }, f({ coat: ['orange'] })), false);
  assert.strictEqual(matches(s(1, 1), { id: 1, coat: null }, emptyFilter()), true);
});

check('toggle adds then removes', () => {
  const t = emptyFilter();
  toggle(t, 'coat', 'orange');
  assert.strictEqual(isActive(t), true);
  toggle(t, 'coat', 'orange');
  assert.strictEqual(isActive(t), false);
});

/* ── where a sighting's tags come from ─────────────────────────────────── */

check('coat and size are read off the CAT, not the sighting', () => {
  const cats = index(cat(7, { coat: ['calico'] }));
  assert.deepStrictEqual(filterSightings([s(1, 7)], cats, f({ coat: ['calico'] })).length, 1);
});

check('A PENDING UPLOAD IS FILTERED ON ITS OWN TAGS — it has no cat yet', () => {
  // The Worker mints the cat when the row lands. Until then the coat and size she typed
  // live on the queued row, and reading them from a cat that does not exist would make a
  // pending orange cat vanish the instant she tapped "orange".
  const pending = { clientId: 'abc', catId: null, coat: ['orange'], size: null, petted: null };
  assert.strictEqual(matches(pending, null, f({ coat: ['orange'] })), true);
  assert.strictEqual(matches(pending, null, f({ coat: ['black'] })), false);
});

check('catId 0 is a real id and must not be treated as "no cat"', () => {
  const cats = index(cat(0, { coat: ['black'] }));
  assert.strictEqual(filterSightings([s(1, 0)], cats, f({ coat: ['black'] })).length, 1);
});

check('a cat id with no cat yet is untagged rather than a crash', () => {
  // Transient: the two halves of the store can be momentarily out of step, and this is a
  // render path. A sighting that claims a cat is NOT filtered as if it carried its own
  // tags — that would silently read fields off the wrong object.
  assert.strictEqual(matches(s(1, 99), null, f({ coat: ['black'] })), false);
  assert.strictEqual(matches(s(1, 99), null, emptyFilter()), true);
});

/* ── the territory half ────────────────────────────────────────────────── */

check('coat takes a cat in or out WHOLE, so a blob is never drawn around hidden points', () => {
  const cats = [{ ...cat(1, { coat: ['orange'] }), sightings: [s(1, 1), s(2, 1), s(3, 1)] }];
  const out = filterCats(cats, f({ coat: ['orange'] }));
  assert.strictEqual(out.length, 1);
  assert.deepStrictEqual(out[0].sightings.map((x) => x.id), [1, 2, 3],
    'coat is the CAT’s, so every one of its photos comes with it');
});

check('PETTED drops individual photos, because it is the photo’s own fact', () => {
  const cats = [{
    ...cat(1, { coat: ['orange'] }),
    sightings: [s(1, 1, { petted: 'yes' }), s(2, 1, { petted: 'no' }), s(3, 1)],
  }];
  const out = filterCats(cats, f({ petted: ['yes'] }));
  assert.strictEqual(out.length, 1);
  assert.deepStrictEqual(out[0].sightings.map((x) => x.id), [1]);
});

check('a cat left with NO surviving photo leaves too, or its blob has nothing inside it', () => {
  const cats = [{ ...cat(1), sightings: [s(1, 1, { petted: 'no' })] }];
  assert.deepStrictEqual(filterCats(cats, f({ petted: ['yes'] })), []);
});

check('a cat that does not match disappears rather than becoming an empty blob', () => {
  const cats = [{ ...cat(1, { coat: ['black'] }), sightings: [s(1, 1)] }];
  assert.deepStrictEqual(filterCats(cats, f({ coat: ['orange'] })), []);
});

check('filterCats does not mutate the store', () => {
  const cats = [{
    ...cat(1, { coat: ['orange'] }),
    sightings: [s(1, 1, { petted: 'yes' }), s(2, 1, { petted: 'no' })],
  }];
  filterCats(cats, f({ coat: ['orange'], petted: ['yes'] }));
  assert.strictEqual(cats[0].sightings.length, 2, 'the store’s own array is untouched');
});

console.log(`filter: ${pass} checks passed`);
