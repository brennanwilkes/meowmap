// The offline queue state machine. Local only, no framework:
//   node tests/outbox.test.mjs
//
// IndexedDB does not exist in Node, so this tests the PURE half — which is deliberately
// where all the decisions live. Between capture and upload this queue is the only copy
// of a camera photo, so "never lose the row" is the property under test.

import assert from 'node:assert';
import {
  STATE, backoffMs, bannerText, classifyError, isDue, nextAfterFailure, newRow,
} from '../frontend/app/outbox.js';
import {
  FLUSH_BACKOFF_BASE_MS, FLUSH_BACKOFF_MAX_MS, FLUSH_MAX_ATTEMPTS, OUTBOX_NAG_AFTER_MS,
} from '../frontend/config.js';

let pass = 0;
const check = (name, fn) => {
  try { fn(); pass++; }
  catch (e) { console.error(`FAIL  ${name}\n      ${e.message}`); process.exitCode = 1; }
};

const NOW = Date.UTC(2026, 8, 11, 12, 0, 0);
const row = (over = {}) => ({
  clientId: 'a3f1c2d4-1111-4222-8333-444455556666',
  kind: 'sighting.create',
  createdAt: NOW,
  state: STATE.pending,
  attempts: 0,
  nextAttemptAt: NOW,
  lastError: null,
  ...over,
});
const err = (status, message = 'boom') => ({ status, message });
const noJitter = () => 0.5;

/* ── error classification ──────────────────────────────────────────────── */

check('a network failure is always retryable — the normal case for this app', () => {
  const c = classifyError(err(0, 'No connection'));
  assert.strictEqual(c.retryable, true);
  assert.strictEqual(c.reason, 'offline');
});

check('a 401 is retryable, because it just means "solve Turnstile again"', () => {
  // iOS ITP evicts localStorage after 7 idle days, so this is routine, not an error.
  assert.strictEqual(classifyError(err(401)).retryable, true);
  assert.strictEqual(classifyError(err(401)).reason, 'needs-pass');
});

check('a budget refusal is retryable but SLOW, and flagged for the user', () => {
  for (const s of [507, 503]) {
    const c = classifyError(err(s));
    assert.strictEqual(c.retryable, true, `${s} should retry`);
    assert.strictEqual(c.slow, true, `${s} should back off hard`);
    assert.strictEqual(c.reason, 'budget');
  }
});

check('a rejection is terminal, so we do not retry forever', () => {
  assert.strictEqual(classifyError(err(413)).retryable, false);
  assert.strictEqual(classifyError(err(400)).retryable, false);
  assert.strictEqual(classifyError(err(422)).retryable, false);
});

check('a server error is retryable', () => {
  assert.strictEqual(classifyError(err(500)).retryable, true);
  assert.strictEqual(classifyError(err(429)).retryable, true);
});

/* ── backoff ───────────────────────────────────────────────────────────── */

check('backoff grows exponentially and then caps', () => {
  assert.strictEqual(backoffMs(1, noJitter), FLUSH_BACKOFF_BASE_MS);
  assert.strictEqual(backoffMs(2, noJitter), FLUSH_BACKOFF_BASE_MS * 2);
  assert.strictEqual(backoffMs(3, noJitter), FLUSH_BACKOFF_BASE_MS * 4);
  assert.strictEqual(backoffMs(99, noJitter), FLUSH_BACKOFF_MAX_MS);
});

check('backoff is jittered, so a batch of failures does not retry in lockstep', () => {
  const lo = backoffMs(3, () => 0);
  const hi = backoffMs(3, () => 1);
  assert.ok(lo < hi, 'jitter should spread the delay');
  const mid = FLUSH_BACKOFF_BASE_MS * 4;
  assert.ok(lo >= mid * 0.7 && hi <= mid * 1.3, `jitter out of range: ${lo}..${hi}`);
});

/* ── transitions ───────────────────────────────────────────────────────── */

check('a retryable failure stays pending and schedules a retry', () => {
  const next = nextAfterFailure(row(), err(0), NOW, noJitter);
  assert.strictEqual(next.state, STATE.pending);
  assert.strictEqual(next.attempts, 1);
  assert.ok(next.nextAttemptAt > NOW, 'should be scheduled into the future');
  assert.strictEqual(next.lastError, 'boom', 'the error is kept so the UI can explain itself');
});

check('a terminal failure goes to failed immediately', () => {
  const next = nextAfterFailure(row(), err(413, 'Photo too large'), NOW, noJitter);
  assert.strictEqual(next.state, STATE.failed);
  assert.strictEqual(next.lastError, 'Photo too large', 'the server message is kept verbatim');
});

check('a retryable failure gives up after the attempt cap', () => {
  const next = nextAfterFailure(row({ attempts: FLUSH_MAX_ATTEMPTS - 1 }), err(0), NOW, noJitter);
  assert.strictEqual(next.attempts, FLUSH_MAX_ATTEMPTS);
  assert.strictEqual(next.state, STATE.failed);
});

check('FAILED IS NOT DELETION — the row and its photo survive', () => {
  // The single most important property in this file.
  const next = nextAfterFailure(row({ attempts: 99 }), err(400), NOW, noJitter);
  assert.strictEqual(next.clientId, row().clientId, 'the row must still exist');
  assert.strictEqual(next.kind, 'sighting.create');
  assert.strictEqual(next.createdAt, NOW);
  assert.ok('lastError' in next, 'and it must explain itself');
});

check('a budget refusal waits out the long backoff rather than hammering', () => {
  const next = nextAfterFailure(row(), err(507, 'Photo storage is full'), NOW, noJitter);
  assert.strictEqual(next.state, STATE.pending);
  assert.strictEqual(next.nextAttemptAt, NOW + FLUSH_BACKOFF_MAX_MS);
  assert.match(next.lastError, /storage is full/);
});

check('isDue respects both state and schedule', () => {
  assert.strictEqual(isDue(row(), NOW), true);
  assert.strictEqual(isDue(row({ nextAttemptAt: NOW + 1000 }), NOW), false);
  assert.strictEqual(isDue(row({ state: STATE.failed }), NOW), false);
  assert.strictEqual(isDue(row({ state: STATE.inflight }), NOW), false);
});

check('newRow starts pending and immediately due', () => {
  const r = newRow({ clientId: 'x', lat: 48.4, lon: -123.3 }, NOW);
  assert.strictEqual(r.state, STATE.pending);
  assert.strictEqual(r.attempts, 0);
  assert.strictEqual(r.nextAttemptAt, NOW);
  assert.strictEqual(r.kind, 'sighting.create', 'kind defaults but is present from day one');
  assert.strictEqual(r.lat, 48.4, 'draft fields are carried through');
});

/* ── the banner ────────────────────────────────────────────────────────── */

check('no banner when the queue is empty', () => {
  assert.strictEqual(bannerText([], NOW), null);
});

check('the banner counts pending photos and stays calm at first', () => {
  const b = bannerText([row(), row()], NOW);
  assert.strictEqual(b.stale, false);
  assert.match(b.text, /2 photos/);
});

check('the banner escalates once something has been waiting', () => {
  const old = row({ createdAt: NOW - OUTBOX_NAG_AFTER_MS - 1 });
  const b = bannerText([old], NOW);
  assert.strictEqual(b.stale, true);
  assert.match(b.text, /waiting a while/);
});

check('a failed row makes the banner urgent and offers the escape hatch', () => {
  // capture= photos never reach the camera roll, so "save it to your phone" is the
  // only thing standing between a failed upload and a lost photo.
  const b = bannerText([row({ state: STATE.failed })], NOW);
  assert.strictEqual(b.stale, true);
  assert.match(b.text, /save it to your phone/i);
});

console.log(`outbox: ${pass} checks passed`);
