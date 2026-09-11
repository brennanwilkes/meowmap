// Input validation. Every value here arrives from a public endpoint with no password,
// so this is the attack surface.
//   node --test --experimental-strip-types test/*.test.ts

import { test } from 'node:test';
import assert from 'node:assert';
import {
  coatTags, int, lat, lon, num, optId, optStr, seenAt, str, uuid, validators,
} from '../src/validate.ts';
import { HttpError } from '../src/types.ts';
import { assertHash, slugify } from '../src/storage.ts';

const NOW = Date.UTC(2026, 8, 10);

test('coordinates outside the world are rejected, not clamped', () => {
  // Clamping would put a pin somewhere plausible-looking and nobody would ever notice.
  assert.strictEqual(lat(48.4266), 48.4266);
  assert.strictEqual(lon(-123.3505), -123.3505);
  for (const bad of [91, -91, NaN, Infinity, '48', null]) {
    assert.throws(() => lat(bad as never), HttpError, `lat accepted ${bad}`);
  }
  for (const bad of [181, -181, NaN]) {
    assert.throws(() => lon(bad as never), HttpError, `lon accepted ${bad}`);
  }
});

test('0 is a valid coordinate and a valid id', () => {
  // The codebase bans falsy checks precisely because of these two.
  assert.strictEqual(lat(0), 0);
  assert.strictEqual(lon(0), 0);
  assert.strictEqual(optId(0, 'catId'), 0);
});

test('optId distinguishes absent, null and zero', () => {
  assert.strictEqual(optId(undefined, 'catId'), undefined, 'absent means leave alone');
  assert.strictEqual(optId(null, 'catId'), null, 'null means unlink');
  assert.strictEqual(optId(0, 'catId'), 0, 'zero means cat 0');
  assert.throws(() => optId(-1, 'catId'), HttpError);
  assert.throws(() => optId(1.5, 'catId'), HttpError);
});

test('coat tags are whitelisted, deduped and sorted', () => {
  assert.deepStrictEqual(coatTags(['tabby', 'orange', 'tabby'], 'coat'), ['orange', 'tabby']);
  assert.deepStrictEqual(coatTags([], 'coat'), []);
  assert.deepStrictEqual(coatTags(null, 'coat'), [], 'null clears the tags');
  assert.strictEqual(coatTags(undefined, 'coat'), undefined, 'absent leaves them alone');
  assert.throws(() => coatTags(['purple'], 'coat'), HttpError);
  assert.throws(() => coatTags('orange' as never, 'coat'), HttpError);
});

test('sorting coat tags makes storage order-independent', () => {
  assert.deepStrictEqual(
    coatTags(['tabby', 'orange'], 'coat'),
    coatTags(['orange', 'tabby'], 'coat'),
  );
});

test('enum fields reject anything unlisted', () => {
  assert.strictEqual(validators.petted('fled'), 'fled');
  assert.strictEqual(validators.size('chonk'), 'chonk');
  assert.throws(() => validators.petted('maybe'), HttpError);
  assert.throws(() => validators.size('enormous'), HttpError);
  assert.throws(() => validators.locationSource('guess'), HttpError);
});

test('a photo from the future or from 1970 is bad data', () => {
  assert.strictEqual(seenAt(NOW - 1000, NOW), NOW - 1000);
  assert.doesNotThrow(() => seenAt(NOW + 3_600_000, NOW), 'an hour of clock skew is fine');
  assert.throws(() => seenAt(NOW + 3 * 86_400_000, NOW), HttpError, 'three days ahead is not');
  assert.throws(() => seenAt(0, NOW), HttpError);
});

test('strings are trimmed, length-capped, and empty becomes null', () => {
  assert.strictEqual(optStr('  hi  ', 'note', 10), 'hi');
  assert.strictEqual(optStr('   ', 'note', 10), null);
  assert.strictEqual(optStr(null, 'note', 10), null);
  assert.throws(() => str('x'.repeat(11), 'note', 10), HttpError);
  assert.throws(() => str(123 as never, 'note', 10), HttpError);
});

test('uuid is strict — clientId is the idempotency key', () => {
  const good = 'a3f1c2d4-1111-4222-8333-444455556666';
  assert.strictEqual(uuid(good, 'clientId'), good);
  assert.strictEqual(uuid(good.toUpperCase(), 'clientId'), good, 'normalised to lower case');
  for (const bad of ['', 'not-a-uuid', good.slice(0, -1), `${good}x`]) {
    assert.throws(() => uuid(bad, 'clientId'), HttpError);
  }
});

test('photo hashes must be exactly 64 lowercase hex', () => {
  const good = 'a'.repeat(64);
  assert.strictEqual(assertHash(good), good);
  for (const bad of ['', 'a'.repeat(63), 'a'.repeat(65), 'A'.repeat(64), `${'a'.repeat(63)}z`]) {
    assert.throws(() => assertHash(bad), HttpError, `accepted ${bad.slice(0, 8)}…`);
  }
});

test('a hash cannot be used to escape the key prefix', () => {
  // The hash is interpolated into an R2 key, so path traversal would be a real bug.
  assert.throws(() => assertHash('../../etc/passwd'), HttpError);
  assert.throws(() => assertHash(`${'a'.repeat(60)}/../`), HttpError);
});

test('slugify produces a stable, url-safe slug', () => {
  assert.strictEqual(slugify('Mochi'), 'mochi');
  assert.strictEqual(slugify('Sergeant Tuxedo'), 'sergeant-tuxedo');
  assert.strictEqual(slugify('  Mr. Bigglesworth!  '), 'mr-bigglesworth');
  assert.strictEqual(slugify('Café'), 'cafe', 'accents are folded, not dropped as unknown');
});

test('numeric bounds are inclusive and reject non-finite values', () => {
  assert.strictEqual(num(5, 'n', 0, 10), 5);
  assert.strictEqual(num(0, 'n', 0, 10), 0);
  assert.strictEqual(num(10, 'n', 0, 10), 10);
  assert.throws(() => num(11, 'n', 0, 10), HttpError);
  assert.throws(() => int(1.5, 'n', 0, 10), HttpError);
  assert.throws(() => num(NaN, 'n', 0, 10), HttpError);
});
