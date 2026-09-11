/* Lifted VERBATIM from ~/spirit-tracker-api/src/jwt.ts — HS256 over WebCrypto, and it
 * already throws rather than returning null, which matches the no-silent-fallback rule.
 * The only edits are additive: an `iat` field, and .ts import specifiers.
 * Callers must additionally check payload.typ === PASS_TYP; verifyJwt does not know
 * about token kinds. */
import { b64UrlToBytes, b64UrlToJson, bytesToB64Url, jsonToB64Url } from './base64url.ts';

export type JwtPayload = {
  sub: string;
  exp: number;
  iss: string;
  aud: string | string[];

  iat?: number;   // issue time; lets the audit log spot a very old pass in use
  typ?: string;   // 'upload_pass'
};

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  );
}

export async function signJwt(payload: JwtPayload, secret: string): Promise<string> {
  const header = { alg: 'HS256', typ: 'JWT' };
  const encodedHeader = jsonToB64Url(header);
  const encodedPayload = jsonToB64Url(payload);
  const data = `${encodedHeader}.${encodedPayload}`;
  const sig = await crypto.subtle.sign(
    'HMAC',
    await hmacKey(secret),
    new TextEncoder().encode(data)
  );
  return `${data}.${bytesToB64Url(new Uint8Array(sig))}`;
}

export async function verifyJwt(token: string, secret: string, opts: { iss: string; aud: string; now?: number }): Promise<JwtPayload> {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Invalid token');

  const [h, p, s] = parts;
  const header = b64UrlToJson<{ alg?: string }>(h);
  if (header.alg !== 'HS256') throw new Error('Invalid token');

  const data = `${h}.${p}`;
  const ok = await crypto.subtle.verify(
    'HMAC',
    await hmacKey(secret),
    b64UrlToBytes(s),
    new TextEncoder().encode(data)
  );
  if (!ok) throw new Error('Invalid token');

  const payload = b64UrlToJson<JwtPayload>(p);
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== 'number' || payload.exp <= now) throw new Error('Token expired');
  if (payload.iss !== opts.iss) throw new Error('Invalid token');

  const aud = payload.aud;
  const audOk = Array.isArray(aud) ? aud.includes(opts.aud) : aud === opts.aud;
  if (!audOk) throw new Error('Invalid token');

  if (typeof payload.sub !== 'string' || payload.sub.length < 1) throw new Error('Invalid token');
  return payload;
}
