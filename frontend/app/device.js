import { LS } from '../config.js';

/* Per-device identity and the upload pass.
 *
 * The device id is a LABEL, not an identity — it lives in localStorage and anyone can
 * rotate it. Its job is to let Brennan tell his phone from his wife's in the audit log,
 * not to authorise anything. The server treats it the same way.
 *
 * NOTE for iOS: ITP evicts localStorage after 7 days without interaction, so a
 * long-unused device silently becomes a new one and gets challenged again. That is
 * acceptable — it just means "401 -> solve Turnstile -> retry" is a NORMAL path, not an
 * error state, and every caller must treat it as such. */

function read(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    // Private mode and blocked site-data both throw on access rather than returning null.
    return null;
  }
}

function write(key, value) {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

let cachedId = null;

export function deviceId() {
  if (cachedId !== null) return cachedId;
  const existing = read(LS.deviceId);
  if (existing !== null && existing !== '') {
    cachedId = existing;
    return cachedId;
  }
  cachedId = crypto.randomUUID();
  write(LS.deviceId, cachedId);
  return cachedId;
}

/* ── the upload pass ───────────────────────────────────────────────────── */

export function getPass() {
  const raw = read(LS.pass);
  if (raw === null) return null;
  try {
    const { pass, expiresAt } = JSON.parse(raw);
    if (typeof pass !== 'string' || typeof expiresAt !== 'number') return null;
    // Treat a pass in its last minute as absent rather than racing the server clock.
    if (expiresAt - 60_000 < Date.now()) return null;
    return pass;
  } catch {
    return null;
  }
}

export function setPass(pass, expiresAt) {
  write(LS.pass, JSON.stringify({ pass, expiresAt }));
}

export function clearPass() {
  try { localStorage.removeItem(LS.pass); } catch { /* nothing useful to do */ }
}

/** A renewed pass arrives in X-Pass-Renewed on any successful mutation. Swapping it in
 *  is what stops both phones being challenged every 30 days. The server does not send
 *  a new expiry, so it is recomputed from the advertised TTL. */
export function absorbRenewal(res, passTtlDays) {
  const renewed = res.headers.get('X-Pass-Renewed');
  if (renewed === null) return;
  setPass(renewed, Date.now() + passTtlDays * 86_400_000);
}

/* ── small per-device preferences ──────────────────────────────────────── */

export function getPref(key, fallback) {
  const raw = read(key);
  return raw === null ? fallback : raw;
}

export function setPref(key, value) {
  write(key, String(value));
}

/** Defensive: a corrupt or stale-schema blob degrades to the default rather than
 *  throwing during a render. */
export function getJsonPref(key, fallback) {
  const raw = read(key);
  if (raw === null) return fallback;
  try {
    const parsed = JSON.parse(raw);
    return parsed === null || typeof parsed !== 'object' ? fallback : parsed;
  } catch {
    return fallback;
  }
}

export function setJsonPref(key, value) {
  write(key, JSON.stringify(value));
}
