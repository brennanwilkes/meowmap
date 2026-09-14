import * as api from './api.js';
import * as outbox from './outbox.js';
import * as store from './store.js';

/* The flush loop.
 *
 * LIVES IN THE PAGE, NOT THE SERVICE WORKER — deliberately, and there is no
 * progressive-enhancement path. Background Sync has never shipped in any Safari
 * version and this app is iPhone only, so a service-worker sync path would be dead
 * code that invites the false belief that uploads complete in the background. They do
 * not: if she photographs ten cats in a park with no signal and closes the app,
 * nothing moves until she reopens it with signal and leaves it foregrounded.
 *
 * Strictly SERIAL. Parallel 550 KB uploads on cell data just time each other out, and
 * serial keeps the failure story simple enough to reason about.
 */

let inFlight = null;      // coalesces overlapping triggers into one pass
let timer = null;         // chained, not an interval — see scheduleNext
let needsPassHandler = null;

/** The capture page registers the Turnstile exchange here. Until it does, a 401 simply
 *  backs off and retries; it is never treated as a hard failure. */
export function onNeedsPass(fn) {
  needsPassHandler = fn;
}

async function publish() {
  store.setPending(await outbox.all());
}

/**
 * Upload one queued sighting: thumb, then full, then the metadata row.
 *
 * Thumb first on purpose — it is ~40 KB against ~550 KB, so on a bad connection the
 * map can show a real thumbnail long before the full image lands. Each photo POST is
 * independently retryable, and both are content-addressed, so a partial upload costs
 * two cheap HEADs on the retry rather than re-sending everything.
 */
async function sendOne(row) {
  const thumb = await api.uploadPhoto('thumb', new Blob([row.thumbBytes], { type: 'image/jpeg' }));
  const full = await api.uploadPhoto('full', new Blob([row.fullBytes], { type: 'image/jpeg' }));

  const { sighting } = await api.createSighting({
    clientId: row.clientId,
    catId: row.catId ?? null,
    // Names the cat the Worker mints for this sighting. Ignored when catId is set, so
    // linking at save time can never rename the cat she picked.
    catName: row.name ?? null,
    lat: row.lat,
    lon: row.lon,
    locationSource: row.locationSource,
    accuracyM: row.accuracyM ?? null,
    seenAt: row.seenAt,
    coat: row.coat ?? [],
    size: row.size ?? null,
    petted: row.petted ?? null,
    note: row.note ?? null,
    photoFull: full.hash,
    photoThumb: thumb.hash,
    photoW: row.fullW,
    photoH: row.fullH,
  });

  // Server row in, queue row out, one transaction. A crash between them would lose
  // both copies of a photo that exists nowhere else.
  await outbox.markSent(row.clientId, sighting);
  return sighting;
}

async function pass() {
  const now = Date.now();
  const rows = await outbox.due(now);
  if (rows.length === 0) return;

  for (const row of rows) {
    await outbox.update({ ...row, state: outbox.STATE.inflight });
    try {
      await sendOne(row);
    } catch (err) {
      const { reason } = outbox.classifyError(err);

      if (reason === 'needs-pass' && needsPassHandler !== null) {
        try {
          await needsPassHandler();
          // Put it straight back in the queue rather than counting this as an attempt:
          // re-verifying is not the upload failing.
          await outbox.update({ ...row, state: outbox.STATE.pending, nextAttemptAt: Date.now() });
          continue;
        } catch {
          // fall through and back off normally
        }
      }
      await outbox.update(outbox.nextAfterFailure(row, err, Date.now()));

      // One bad row must not stall the ones behind it, but a genuine outage should
      // stop the pass rather than burning through every row's attempt budget.
      if (reason === 'offline' || reason === 'budget') break;
    }
    await publish();
  }

  await publish();
  await store.refresh();
}

/**
 * A chained timeout armed to the earliest due row, not a polling interval. On a phone
 * this matters: an interval wakes the page forever for a queue that is usually empty.
 */
async function scheduleNext() {
  if (timer !== null) { clearTimeout(timer); timer = null; }
  const rows = await outbox.all();
  const waiting = rows.filter((r) => r.state === outbox.STATE.pending);
  if (waiting.length === 0) return;
  const soonest = Math.min(...waiting.map((r) => r.nextAttemptAt));
  const delay = Math.max(1000, soonest - Date.now());
  timer = setTimeout(() => { timer = null; flush(); }, delay);
}

export function flush() {
  if (inFlight !== null) return inFlight;
  inFlight = pass()
    .catch((err) => console.error('[flush] pass failed:', err))
    .finally(() => { inFlight = null; scheduleNext(); });
  return inFlight;
}

/** Call once at boot, after the DB is open. */
export async function start() {
  // inflight is NOT durable state: iOS may kill a backgrounded app mid-request, and
  // server-side idempotency absorbs a request that actually did land.
  const recovered = await outbox.resetInflight();
  if (recovered > 0) console.warn(`[flush] recovered ${recovered} interrupted upload(s)`);

  await publish();

  // navigator.onLine is a link-layer signal, not reachability — it reads true on a
  // captive portal. Use it only to try SOONER, never to suppress an attempt.
  window.addEventListener('online', () => flush());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') flush();
  });

  flush();
}

/** Queue a freshly captured sighting and try immediately. */
export async function enqueue(draft) {
  const row = outbox.newRow(draft, Date.now());
  await outbox.enqueue(row);
  await publish();
  flush();
  return row;
}

/**
 * Link a still-queued sighting to a cat. Returns false when the row has already
 * uploaded, which is the caller's signal to PATCH the server row instead — silently
 * doing nothing there would drop a link she explicitly made.
 */
export async function linkWhenUploaded(clientId, catId) {
  const row = await outbox.setCatId(clientId, catId);
  await publish();
  if (row === null) return false;
  flush();
  return true;
}

export async function retry(clientId) {
  await outbox.retryNow(clientId);
  await publish();
  return flush();
}

/** The escape hatch for a failed row: hand the photo back so it can be re-added from
 *  the camera roll. In-app camera photos never land there on their own, so without
 *  this a terminal failure means the photo is gone. */
export async function downloadCopy(clientId) {
  const rows = await outbox.all();
  const row = rows.find((r) => r.clientId === clientId);
  if (row === undefined) throw new Error('That photo is no longer queued');
  const url = URL.createObjectURL(new Blob([row.fullBytes], { type: 'image/jpeg' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `meowmap-${new Date(row.createdAt).toISOString().slice(0, 19).replace(/[:T]/g, '-')}.jpg`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export async function discard(clientId) {
  await outbox.remove(clientId);
  await publish();
}
