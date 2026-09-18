// Cat identity colours. Local only, no framework:  node tests/catcolor.test.mjs
import assert from 'node:assert';
import { CAT_PALETTE, catColour, displayName, inkFor, ringFor, shortTag }
  from '../frontend/app/catcolor.js';

let pass = 0;
const check = (name, fn) => {
  try { fn(); pass++; }
  catch (e) { console.error(`FAIL  ${name}\n      ${e.message}`); process.exitCode = 1; }
};

check('the same cat is the same colour every time', () => {
  for (const id of [0, 1, 7, 42, 999]) {
    assert.strictEqual(catColour(id).hex, catColour(id).hex);
  }
});

check('id 0 is a real cat, not a missing one', () => {
  // The whole reason this codebase bans falsy id checks.
  const c = catColour(0);
  assert.notStrictEqual(c, null, 'cat 0 must get a colour');
  assert.match(c.hex, /^#[0-9a-f]{6}$/);
});

check('no cat means no colour, and that is distinct from cat 0', () => {
  assert.strictEqual(catColour(null), null);
  assert.strictEqual(catColour(undefined), null);
  assert.strictEqual(ringFor(null), 'var(--paper-hi)');
  assert.notStrictEqual(ringFor(0), 'var(--paper-hi)');
});

check('consecutive ids do not get adjacent hues', () => {
  // Sequential rowids mean neighbouring ids are the cats most likely to share a block,
  // so `id % 12` would be the worst possible assignment. The coprime stride guarantees
  // a gap of 5 or 7 in palette space, so this should be exactly zero — not merely rare.
  let adjacent = 0;
  for (let id = 0; id < 60; id++) {
    const a = CAT_PALETTE.indexOf(catColour(id));
    const b = CAT_PALETTE.indexOf(catColour(id + 1));
    if (Math.abs(a - b) === 1) adjacent++;
  }
  assert.strictEqual(adjacent, 0, `${adjacent}/60 consecutive pairs are adjacent hues — the stride is not coprime`);
});

check('consecutive ids never collide outright', () => {
  for (let id = 0; id < 200; id++) {
    assert.notStrictEqual(
      catColour(id).hex, catColour(id + 1).hex,
      `cats ${id} and ${id + 1} share a colour`,
    );
  }
});

check('the palette is used broadly, not clustered', () => {
  const seen = new Map();
  for (let id = 0; id < 240; id++) {
    const h = catColour(id).hex;
    seen.set(h, (seen.get(h) ?? 0) + 1);
  }
  assert.strictEqual(seen.size, CAT_PALETTE.length, 'some shades are never used');
  const counts = [...seen.values()];
  const spread = Math.max(...counts) / Math.min(...counts);
  assert.ok(spread < 2.5, `distribution is lumpy: ${Math.min(...counts)}..${Math.max(...counts)}`);
});

check('text stays legible on every fill', () => {
  for (let id = 0; id < 24; id++) {
    const ink = inkFor(id);
    assert.ok(ink === '#ffffff' || ink === 'var(--ink)');
  }
});

check('an unnamed cat has no name, and says so by saying nothing', () => {
  // Unnamed is blank, and every caller draws nothing rather than an empty mark.
  assert.strictEqual(displayName(null), '');
  assert.strictEqual(displayName({ name: null }), '');
  assert.strictEqual(displayName({ name: '' }), '');
  assert.strictEqual(displayName({ name: '   ' }), '');
  assert.strictEqual(displayName({ name: '  Mochi ' }), 'Mochi');
});

check('shortTag is a stable word, usable for disambiguation', () => {
  assert.strictEqual(shortTag(5), shortTag(5));
  assert.strictEqual(shortTag(null), '');
  assert.ok(CAT_PALETTE.some((c) => c.name === shortTag(5)));
});

console.log(`catcolor: ${pass} checks passed`);
