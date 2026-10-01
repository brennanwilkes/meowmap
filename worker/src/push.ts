import type { Env } from './types.ts';
import { DEVICE_OWNERS, PUSH_TTL_S, VAPID_PUBLIC_KEY, VAPID_SUBJECT } from './constants.ts';
import { b64UrlToBytes, bytesToB64Url, jsonToB64Url } from './base64url.ts';
import * as db from './storage.ts';

/* Web Push, by hand, on WebCrypto alone — the same zero-dependency rule as jwt.ts.
 *
 * Two pieces, both standard and both small:
 *   - RFC 8291 payload encryption (aes128gcm), so the push service relays bytes it
 *     cannot read. Verified against the RFC's own Appendix A vector in push.test.ts.
 *   - RFC 8292 VAPID, an ES256 JWT proving the push came from the holder of the key the
 *     phone subscribed with.
 *
 * iOS REQUIRES every push to show a notification, and revokes the permission from a page
 * that receives pushes and shows nothing. So nothing is ever sent silently; see the push
 * handler in sw.js. */

const enc = new TextEncoder();

/** A single aes128gcm record holds 4096 bytes minus the 16-byte tag and the delimiter.
 *  A title and a note are nowhere near it; a payload that is near it is a bug. */
const RECORD_SIZE = 4096;
const MAX_PLAINTEXT = RECORD_SIZE - 17;

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, length * 8),
  );
}

/**
 * RFC 8291 §3-4, one record. Every random input is a parameter so the RFC's test vector
 * can pin them; `sendPush` is the only real caller and it draws them fresh each time.
 *
 * @param serverPrivate an ECDH P-256 private key, used for this one message only
 * @param serverPublic  its public half as a 65-byte uncompressed point
 */
export async function encryptPayload(
  plaintext: Uint8Array, uaPublic: Uint8Array, authSecret: Uint8Array,
  salt: Uint8Array, serverPrivate: CryptoKey, serverPublic: Uint8Array,
): Promise<Uint8Array> {
  if (plaintext.length > MAX_PLAINTEXT) throw new Error(`push payload is ${plaintext.length} bytes`);

  const uaKey = await crypto.subtle.importKey(
    'raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, [],
  );
  // workers-types names the field `$public`; the runtime, like every WebCrypto, reads `public`.
  const shared = new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'ECDH', public: uaKey } as unknown as SubtleCryptoDeriveKeyAlgorithm, serverPrivate, 256,
  ));

  const ikm = await hkdf(authSecret, shared, concat(enc.encode('WebPush: info\0'), uaPublic, serverPublic), 32);
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);

  const aes = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  // 0x02 marks the last record, and this is the only one. No padding after it.
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce }, aes, concat(plaintext, new Uint8Array([2])),
  ));

  // salt(16) | record size(4, big-endian) | key id length(1) | key id = server public key
  const header = new Uint8Array(21);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, RECORD_SIZE);
  header[20] = serverPublic.length;
  return concat(header, serverPublic, ciphertext);
}

/** The `Authorization` header for one push service. `aud` is that service's origin, so a
 *  token minted for Apple is useless at Google. */
export async function vapidAuthorization(
  endpoint: string, publicKey: string, privateD: string, nowS: number,
): Promise<string> {
  const pub = b64UrlToBytes(publicKey);
  const key = await crypto.subtle.importKey(
    'jwk',
    {
      kty: 'EC', crv: 'P-256', d: privateD,
      x: bytesToB64Url(pub.slice(1, 33)), y: bytesToB64Url(pub.slice(33, 65)),
    },
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );
  // An hour, though the spec allows 24: a token is minted per send, so a long one buys
  // nothing, and Apple is known to be stricter than the spec here.
  const claims = { aud: new URL(endpoint).origin, exp: nowS + 3600, sub: VAPID_SUBJECT };
  const unsigned = `${jsonToB64Url({ typ: 'JWT', alg: 'ES256' })}.${jsonToB64Url(claims)}`;
  // WebCrypto's ECDSA signature is already the raw r||s that JWS wants, not DER.
  const sig = new Uint8Array(await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(unsigned),
  ));
  return `vapid t=${unsigned}.${bytesToB64Url(sig)}, k=${publicKey}`;
}

/** What sw.js turns into a notification. `hash` is the route a tap opens. */
export interface PushMessage {
  title: string;
  body: string;
  hash: string;
}

async function sendPush(
  env: Env, sub: db.PushSubscriptionRow, message: PushMessage, nowS: number,
): Promise<Response> {
  const server = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'],
  ) as CryptoKeyPair;
  const serverPublic = new Uint8Array(await crypto.subtle.exportKey('raw', server.publicKey) as ArrayBuffer);
  const body = await encryptPayload(
    enc.encode(JSON.stringify(message)),
    b64UrlToBytes(sub.p256dh), b64UrlToBytes(sub.auth),
    crypto.getRandomValues(new Uint8Array(16)), server.privateKey, serverPublic,
  );
  return await fetch(sub.endpoint, {
    method: 'POST',
    headers: {
      'Authorization': await vapidAuthorization(sub.endpoint, VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY, nowS),
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      'TTL': String(PUSH_TTL_S),
      'Urgency': 'normal',
    },
    body,
  });
}

function ownerOf(deviceId: string): string | null {
  return Object.hasOwn(DEVICE_OWNERS, deviceId) ? DEVICE_OWNERS[deviceId] : null;
}

/**
 * Tell every other subscribed phone that a photo landed. Runs in waitUntil after the
 * upload has been answered, so a slow push service never slows her save down.
 *
 * Nobody is told about their own photo: not the device that sent it, and not another
 * device belonging to the same person in DEVICE_OWNERS.
 */
export async function notifySighting(
  env: Env,
  s: { deviceId: string; catId: number; newCat: boolean; note: string | null },
  now: number,
): Promise<void> {
  const sender = ownerOf(s.deviceId);
  const recipients = (await db.listPushSubscriptions(env)).filter((r) => (
    r.device_id !== s.deviceId && (sender === null || ownerOf(r.device_id) !== sender)
  ));
  if (recipients.length === 0) return;

  const name = await db.getCatName(env, s.catId);
  const who = name !== null ? name : s.newCat ? 'a new cat' : 'a cat';
  const message: PushMessage = {
    title: `${sender === null ? 'Someone' : sender} spotted ${who}`,
    body: s.note === null ? 'Tap to see them on the map.' : s.note,
    hash: `#/cat/${s.catId}`,
  };

  const nowS = Math.floor(now / 1000);
  const results = await Promise.allSettled(recipients.map((r) => sendPush(env, r, message, nowS)));
  const dead: D1PreparedStatement[] = [];
  for (const [i, res] of results.entries()) {
    const r = recipients[i];
    const host = new URL(r.endpoint).hostname;
    if (res.status === 'rejected') {
      console.error(`[push] ${host} device ${r.device_id}: send threw`, res.reason);
      continue;
    }
    // 404 and 410 are the push service saying this subscription is gone for good: the
    // phone unsubscribed, or the app was deleted. Anything else may be transient.
    if (res.value.status === 404 || res.value.status === 410) {
      dead.push(db.deleteDeadPushSubscription(env, r.id, r.endpoint));
    } else if (!res.value.ok) {
      // Apple names the reason in the body ("BadJwtToken", "BadDeviceToken"), and it is
      // the only clue to why a phone stopped hearing anything.
      console.error(`[push] ${host} device ${r.device_id}: HTTP ${res.value.status}`,
        (await res.value.text()).slice(0, 300));
    }
  }
  if (dead.length > 0) await env.MEOWMAP_DB.batch(dead);
}
