import { API_BASE, UPLOAD_TIMEOUT_MS } from '../config.js';
import { absorbRenewal, clearPass, deviceId, getPass, setPass } from './device.js';

/* The only module that talks to the Worker.
 *
 * Two error shapes matter to callers and are distinguished deliberately:
 *   NeedsPassError  — 401. NOT a failure: solve Turnstile and retry. On iOS, ITP evicts
 *                     localStorage after 7 days idle, so this is a routine path.
 *   BudgetError     — 507/503. The R2 cost breaker tripped. The caller must KEEP the
 *                     photo queued and tell her, never discard it. */

export class ApiError extends Error {
  constructor(status, message, retryable) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.retryable = retryable;
  }
}
export class NeedsPassError extends ApiError {
  constructor() { super(401, 'This device needs to prove it is a person', false); this.name = 'NeedsPassError'; }
}
export class BudgetError extends ApiError {
  constructor(status, message) { super(status, message, false); this.name = 'BudgetError'; }
}

let config = null;

/** Immutable and content-addressed, so this URL is cacheable forever.
 *  crossorigin="anonymous" on the <img> is REQUIRED: without it the request is no-cors,
 *  the service worker sees an opaque response whose quota accounting is padded, and a
 *  few hundred thumbnails can blow through the storage quota. */
export function photoUrl(hash) {
  return `${API_BASE}/photo/${hash}`;
}

async function parseError(res) {
  let message = `HTTP ${res.status}`;
  try {
    const body = await res.json();
    if (typeof body?.error === 'string') message = body.error;
  } catch { /* keep the status-derived message */ }

  if (res.status === 401) return new NeedsPassError();
  if (res.status === 507 || res.status === 503) return new BudgetError(res.status, message);
  // 408/429/5xx are worth retrying; 4xx generally is not.
  const retryable = res.status === 408 || res.status === 429 || res.status >= 500;
  return new ApiError(res.status, message, retryable);
}

async function request(path, { method = 'GET', body, headers = {}, auth = false, timeoutMs } = {}) {
  const h = new Headers(headers);
  if (auth) {
    const pass = getPass();
    if (pass === null) throw new NeedsPassError();
    h.set('Authorization', `Bearer ${pass}`);
  }

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs ?? UPLOAD_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(`${API_BASE}${path}`, { method, body, headers: h, signal: ac.signal });
  } catch (err) {
    // A network failure or an abort is always worth retrying — this is the airplane-mode
    // and dead-zone case, which is the normal one for this app.
    throw new ApiError(0, err.name === 'AbortError' ? 'Timed out' : 'No connection', true);
  } finally {
    clearTimeout(timer);
  }

  if (auth && config !== null) absorbRenewal(res, config.passTtlDays);
  if (res.status === 401) clearPass();
  if (!res.ok && res.status !== 304) throw await parseError(res);
  return res;
}

/* ── reads ─────────────────────────────────────────────────────────────── */

export async function getConfig() {
  if (config !== null) return config;
  const res = await request('/config', { timeoutMs: 15_000 });
  config = await res.json();
  return config;
}

/**
 * Bulk fetch with a conditional request. A warm client costs the server ONE row read
 * instead of a full table scan, which is the difference between comfortable and
 * constrained as the dataset grows.
 * @returns { changed: false } | { changed: true, etag, version, cats, sightings }
 */
export async function getAll(etag) {
  const headers = etag === null || etag === undefined ? {} : { 'If-None-Match': etag };
  const res = await request('/sightings', { headers, timeoutMs: 20_000 });
  if (res.status === 304) return { changed: false };
  const data = await res.json();
  return { changed: true, etag: res.headers.get('ETag'), ...data };
}

export async function getHealth() {
  const res = await request('/health', { timeoutMs: 10_000 });
  return await res.json();
}

/* ── the pass ──────────────────────────────────────────────────────────── */

export async function exchangeTurnstileToken(token) {
  const res = await request('/pass', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, deviceId: deviceId() }),
    timeoutMs: 20_000,
  });
  const { pass, expiresAt } = await res.json();
  setPass(pass, expiresAt);
  return pass;
}

/* ── writes ────────────────────────────────────────────────────────────── */

/** Raw body rather than multipart: the Workers free plan allows 10 ms CPU per
 *  invocation, and formData() on a ~550 KB body allocates and copies both parts before
 *  the handler can touch them. Splitting also lets each derivative retry independently,
 *  which pairs with the offline queue. */
export async function uploadPhoto(variant, blob) {
  const res = await request(`/photo?variant=${variant}`, {
    method: 'POST',
    headers: { 'Content-Type': 'image/jpeg' },
    body: blob,
    auth: true,
  });
  return await res.json();
}

export async function createSighting(payload) {
  const res = await request('/sightings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...payload, deviceId: deviceId() }),
    auth: true,
  });
  // 200 with duplicate:true means a retried queued upload landed twice; the caller
  // treats it exactly like a fresh 201, which is what makes the queue safe.
  return await res.json();
}

export async function patchSighting(id, patch) {
  const res = await request(`/sightings/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
    auth: true,
  });
  return await res.json();
}

export async function deleteSighting(id) {
  await request(`/sightings/${id}`, { method: 'DELETE', auth: true });
}

/** @param fields {{name?, notes?, coat?, size?, petted?}} — all optional. */
export async function createCat(fields) {
  const res = await request('/cats', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(fields),
    auth: true,
  });
  return await res.json();
}

export async function patchCat(id, patch) {
  const res = await request(`/cats/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
    auth: true,
  });
  return await res.json();
}

/** Its sightings revert to unidentified rather than being deleted. */
export async function deleteCat(id) {
  await request(`/cats/${id}`, { method: 'DELETE', auth: true });
}
