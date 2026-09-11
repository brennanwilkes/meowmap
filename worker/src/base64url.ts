export function bytesToB64Url(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  const b64 = btoa(bin);
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function b64UrlToBytes(b64url: string): Uint8Array {
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
  const pad = b64.length % 4 === 0 ? '' : '='.repeat(4 - (b64.length % 4));
  const bin = atob(b64 + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function jsonToB64Url(obj: unknown): string {
  const text = JSON.stringify(obj);
  return bytesToB64Url(new TextEncoder().encode(text));
}

export function b64UrlToJson<T>(b64url: string): T {
  const bytes = b64UrlToBytes(b64url);
  const text = new TextDecoder().decode(bytes);
  return JSON.parse(text) as T;
}
