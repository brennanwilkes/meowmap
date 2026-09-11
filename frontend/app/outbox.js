import {
  FLUSH_BACKOFF_BASE_MS, FLUSH_BACKOFF_MAX_MS, FLUSH_MAX_ATTEMPTS, OUTBOX_NAG_AFTER_MS,
} from '../config.js';
import * as idb from './idb.js';

/* The offline upload queue.
 *
 * THIS IS THE DURABILITY-CRITICAL MODULE. A photo taken with the in-app camera never
 * reaches the camera roll, and we deliberately do not store originals — so between
 * capture and a successful upload, THIS QUEUE IS THE ONLY COPY. Every decision here
 * favours "never lose the row" over "keep the queue tidy":
 *
 *   - `failed` is a visible state, never a delete. Nothing is silently dropped.
 *   - Success writes the server row and removes the queue row in ONE transaction.
 *   - `inflight` is not durable state; it is reset on boot (see resetInflight).
 *
 * The pure helpers at the top are exported so they can be unit-tested without a DOM —
 * IndexedDB does not exist in Node, but the state machine is where the bugs live.
 */

export const STATE = { pending: 'pending', inflight: 'inflight', failed: 'failed' };

/* ── pure logic ────────────────────────────────────────────────────────── */

/**
 * Exponential backoff with jitter. Jitter matters even for one device: without it, a
 * queue of ten photos that all failed at once retries all ten on the same schedule
 * forever, so they keep colliding on the same bad connection.
 */
export function backoffMs(attempts, rand = Math.random) {
  const base = Math.min(FLUSH_BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1), FLUSH_BACKOFF_MAX_MS);
  const jitter = 1 + (rand() - 0.5) * 0.5;   // +/-25%
  return Math.round(base * jitter);
}

/**
 * Decide what a failure means. Getting this wrong in either direction is costly:
 * retrying a 400 forever burns battery and rate limit, while giving up on a network
 * blip loses a photo.
 */
export function classifyError(err) {
  const status = err?.status ?? 0;

  // 0 is our own marker for "never reached the server" — airplane mode, dead zone,
  // timeout. The normal case for this app, and always worth retrying.
  if (status === 0) return { retryable: true, reason: 'offline' };

  if (status === 401) return { retryable: true, reason: 'needs-pass' };
  if (status === 408 || status === 429) return { retryable: true, reason: 'throttled' };

  // The cost breaker tripped. Retryable in principle — storage may be freed, and the
  // daily cap rolls at midnight — but NOT on the fast path, and the user must be told.
  if (status === 507 || status === 503) return { retryable: true, reason: 'budget', slow: true };

  if (status >= 500) return { retryable: true, reason: 'server' };
  if (status === 413) return { retryable: false, reason: 'too-large' };
  return { retryable: false, reason: 'rejected' };
}

/** Next state for a row that just failed. Pure, so the transitions are testable. */
export function nextAfterFailure(row, err, now, rand = Math.random) {
  const attempts = row.attempts + 1;
  const { retryable, reason, slow } = classifyError(err);

  if (!retryable || attempts >= FLUSH_MAX_ATTEMPTS) {
    return {
      ...row,
      attempts,
      state: STATE.failed,
      lastError: err?.message ?? String(reason),
      nextAttemptAt: now,
    };
  }
  // A budget refusal will not clear in thirty seconds; waiting out the backoff cap
  // avoids hammering a Worker that is deliberately saying no.
  const delay = slow === true ? FLUSH_BACKOFF_MAX_MS : backoffMs(attempts, rand);
  return {
    ...row,
    attempts,
    state: STATE.pending,
    lastError: err?.message ?? String(reason),
    nextAttemptAt: now + delay,
  };
}

export function isDue(row, now) {
  return row.state === STATE.pending && row.nextAttemptAt <= now;
}

/** Wording escalates with age; see OUTBOX_NAG_AFTER_MS. */
export function bannerText(rows, now) {
  if (rows.length === 0) return null;
  const failed = rows.filter((r) => r.state === STATE.failed).length;
  const oldest = Math.min(...rows.map((r) => r.createdAt));
  const stale = now - oldest > OUTBOX_NAG_AFTER_MS;

  if (failed > 0) {
    return {
      stale: true,
      text: failed === 1
        ? '1 photo could not upload. Tap to save it to your phone.'
        : `${failed} photos could not upload. Tap to save them to your phone.`,
    };
  }
  const n = rows.length;
  if (stale) {
    return {
      stale: true,
      text: n === 1
        ? 'A photo has been waiting a while to upload. Tap for options.'
        : `${n} photos have been waiting a while to upload. Tap for options.`,
    };
  }
  return {
    stale: false,
    text: n === 1 ? '1 photo still to upload' : `${n} photos still to upload`,
  };
}

/* ── storage ───────────────────────────────────────────────────────────── */

export function newRow(draft, now) {
  return {
    clientId: draft.clientId,
    kind: draft.kind ?? 'sighting.create',
    createdAt: now,
    state: STATE.pending,
    attempts: 0,
    nextAttemptAt: now,
    lastError: null,
    ...draft,
  };
}

export const enqueue = (row) => idb.put('outbox', row);
export const update = (row) => idb.put('outbox', row);
export const all = () => idb.getAll('outbox');
export const remove = (clientId) => idb.del('outbox', clientId);

/**
 * iOS terminates backgrounded standalone apps aggressively and may cancel an in-flight
 * fetch, so a row can be left marked `inflight` forever with nothing driving it.
 * `inflight` is therefore NOT durable state — reset it on every boot and let
 * server-side idempotency (ON CONFLICT(client_id) DO NOTHING) absorb the case where
 * the request actually did land.
 */
export async function resetInflight() {
  const rows = await idb.getAllByIndex('outbox', 'by_state', STATE.inflight);
  for (const row of rows) {
    await idb.put('outbox', { ...row, state: STATE.pending, nextAttemptAt: Date.now() });
  }
  return rows.length;
}

export async function due(now) {
  const rows = await idb.getAll('outbox');
  return rows.filter((r) => isDue(r, now)).sort((a, b) => a.createdAt - b.createdAt);
}

/**
 * Mark a row uploaded. The server row lands and the queue row disappears in ONE
 * transaction — the whole reason idb.tx2 exists. Doing these as two awaits opens a
 * window where a crash loses both copies of a photo that exists nowhere else.
 */
export function markSent(clientId, serverSighting) {
  return idb.tx2('sightings', 'outbox', (sightings, outbox) => {
    sightings.put(serverSighting);
    outbox.delete(clientId);
  });
}

/**
 * Record "this is that cat" against a row that has not uploaded yet.
 *
 * The suggestion card appears immediately after save, but a queued row has no server id
 * to PATCH — and on a bad connection it may not have one for hours. So the intent is
 * stored on the queue row and sent as part of the original insert. If the row has
 * already uploaded, this returns null and the caller must PATCH instead.
 */
export async function setCatId(clientId, catId) {
  const row = await idb.get('outbox', clientId);
  if (row === undefined) return null;
  const next = { ...row, catId };
  await idb.put('outbox', next);
  return next;
}

/** A manual retry clears the backoff AND the attempt count: the user pressing the
 *  button is new information, not another automatic attempt. */
export async function retryNow(clientId) {
  const row = await idb.get('outbox', clientId);
  if (row === undefined) return null;
  const next = { ...row, state: STATE.pending, attempts: 0, nextAttemptAt: Date.now(), lastError: null };
  await idb.put('outbox', next);
  return next;
}
