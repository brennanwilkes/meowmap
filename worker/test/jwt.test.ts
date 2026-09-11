// The upload pass. Lifted from spirit-tracker-api, but never previously tested — and it
// is now the only thing gating writes on a public, login-free app.
//   node --test --experimental-strip-types test/*.test.ts
//
// Runs without node_modules: WebCrypto, btoa and atob are all Node globals.

import { test } from 'node:test';
import assert from 'node:assert';
import { signJwt, verifyJwt, type JwtPayload } from '../src/jwt.ts';
import { b64UrlToJson, jsonToB64Url } from '../src/base64url.ts';

const SECRET = 'test-secret-not-a-real-one';
const OPTS = { iss: 'meowmap-api', aud: 'meowmap' };
const NOW_S = Math.floor(Date.UTC(2026, 8, 10) / 1000);

function payload(over: Partial<JwtPayload> = {}): JwtPayload {
  return {
    sub: 'a3f1c2d4-0000-4000-8000-000000000001',
    iss: OPTS.iss,
    aud: OPTS.aud,
    iat: NOW_S,
    exp: NOW_S + 30 * 86_400,
    typ: 'upload_pass',
    ...over,
  };
}

test('a freshly signed pass verifies', async () => {
  const token = await signJwt(payload(), SECRET);
  const out = await verifyJwt(token, SECRET, { ...OPTS, now: NOW_S });
  assert.strictEqual(out.sub, payload().sub);
  assert.strictEqual(out.typ, 'upload_pass');
  assert.strictEqual(out.iat, NOW_S, 'iat must survive the round trip');
});

test('a wrong secret is rejected', async () => {
  const token = await signJwt(payload(), SECRET);
  await assert.rejects(
    () => verifyJwt(token, 'a-different-secret', { ...OPTS, now: NOW_S }),
    /Invalid token/,
  );
});

test('an expired pass is rejected', async () => {
  const token = await signJwt(payload({ exp: NOW_S - 1 }), SECRET);
  await assert.rejects(() => verifyJwt(token, SECRET, { ...OPTS, now: NOW_S }), /expired/i);
});

test('a pass for another audience or issuer is rejected', async () => {
  const wrongAud = await signJwt(payload({ aud: 'someone-else' }), SECRET);
  await assert.rejects(() => verifyJwt(wrongAud, SECRET, { ...OPTS, now: NOW_S }), /Invalid token/);
  const wrongIss = await signJwt(payload({ iss: 'someone-else' }), SECRET);
  await assert.rejects(() => verifyJwt(wrongIss, SECRET, { ...OPTS, now: NOW_S }), /Invalid token/);
});

test('an empty subject is rejected', async () => {
  const token = await signJwt(payload({ sub: '' }), SECRET);
  await assert.rejects(() => verifyJwt(token, SECRET, { ...OPTS, now: NOW_S }), /Invalid token/);
});

test('alg=none forgery is rejected', async () => {
  // The classic JWT attack: swap the header to an unsigned algorithm and drop the
  // signature. verifyJwt pins HS256 explicitly, which is what stops this.
  const header = jsonToB64Url({ alg: 'none', typ: 'JWT' });
  const body = jsonToB64Url(payload());
  await assert.rejects(
    () => verifyJwt(`${header}.${body}.`, SECRET, { ...OPTS, now: NOW_S }),
    /Invalid token/,
  );
});

test('a tampered payload is rejected', async () => {
  const token = await signJwt(payload(), SECRET);
  const [h, p, s] = token.split('.');
  const claims = b64UrlToJson<JwtPayload>(p);
  claims.exp = NOW_S + 3650 * 86_400;   // grant myself ten years
  const forged = `${h}.${jsonToB64Url(claims)}.${s}`;
  await assert.rejects(() => verifyJwt(forged, SECRET, { ...OPTS, now: NOW_S }), /Invalid token/);
});

test('a malformed token is rejected rather than crashing', async () => {
  for (const bad of ['', 'x', 'a.b', 'a.b.c.d', '...']) {
    await assert.rejects(() => verifyJwt(bad, SECRET, { ...OPTS, now: NOW_S }));
  }
});

test('rotating the signing secret invalidates every outstanding pass', async () => {
  // This is the documented panic button, so it needs to actually work.
  const token = await signJwt(payload(), SECRET);
  await assert.rejects(() => verifyJwt(token, `${SECRET}-rotated`, { ...OPTS, now: NOW_S }));
});
