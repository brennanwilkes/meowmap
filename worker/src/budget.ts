import type { AppMeta } from './types.ts';
import { HttpError } from './types.ts';
import {
  R2_BYTE_CEILING,
  R2_READ_CEILING,
  UPLOADS_PER_DAY,
  READ_SAMPLE_RATE,
} from './constants.ts';

/* The R2 cost breaker.
 *
 * R2 is the only service in the stack that bills instead of failing closed, and
 * Cloudflare has no native spend cap on it — so this file is the spend cap.
 *
 * The rule it enforces: break functionality before spending money. It must never do the
 * inverse trade, so a refused upload always leaves the photo in the client's outbox. */

export const DAY_MS = 86_400_000;

export function epochDay(now: number): number {
  return Math.floor(now / DAY_MS);
}

/** Calendar-ish month index. Exact month boundaries do not matter — this only has to
 *  roll the read estimate over on roughly the same cadence R2 bills on. */
export function epochMonth(now: number): number {
  const d = new Date(now);
  return d.getUTCFullYear() * 12 + d.getUTCMonth();
}

export interface BudgetView {
  bytesUsed: number;
  bytesCeiling: number;
  objects: number;
  uploadsToday: number;
  uploadsCeiling: number;
  readsEstimated: number;
  readsCeiling: number;
  storageBlocked: boolean;
  uploadsBlocked: boolean;
  readsBlocked: boolean;
}

/** What GET /health reports, so the state of the breaker is one curl away. */
export function view(meta: AppMeta, now: number): BudgetView {
  const today = epochDay(now) === meta.usage_day ? meta.uploads_today : 0;
  const reads = epochMonth(now) === meta.reads_month ? meta.r2_reads_est : 0;
  return {
    bytesUsed: meta.r2_bytes,
    bytesCeiling: R2_BYTE_CEILING,
    objects: meta.r2_objects,
    uploadsToday: today,
    uploadsCeiling: UPLOADS_PER_DAY,
    readsEstimated: reads,
    readsCeiling: R2_READ_CEILING,
    storageBlocked: meta.r2_bytes >= R2_BYTE_CEILING,
    uploadsBlocked: today >= UPLOADS_PER_DAY,
    readsBlocked: reads >= R2_READ_CEILING,
  };
}

/**
 * Gate an upload BEFORE any R2 write.
 *
 * `incomingBytes` is the Content-Length we are about to store. It is only charged
 * against the ceiling when the object turns out to be new — a re-upload of identical
 * bytes is a no-op at the same content-addressed key and must not consume budget.
 *
 * Throws 507 rather than 429: this is "no room", not "too fast", and the client
 * distinguishes them (507 keeps the item queued and tells her; 429 just retries).
 */
export function assertUploadAllowed(meta: AppMeta, now: number, incomingBytes: number): void {
  const v = view(meta, now);

  if (v.uploadsBlocked) {
    throw new HttpError(
      507,
      `Daily upload limit reached (${UPLOADS_PER_DAY}). Your photo is saved on this phone and will upload tomorrow.`,
      'budget',
    );
  }
  if (v.bytesUsed + incomingBytes > R2_BYTE_CEILING) {
    throw new HttpError(
      507,
      'Photo storage is full. Your photo is saved on this phone — free up space before it can upload.',
      'budget',
    );
  }
}

/** Gate a photo read. Serves 503 while leaving the rest of the app working, so the map
 *  still functions with broken images rather than going down entirely. */
export function assertReadAllowed(meta: AppMeta, now: number): void {
  if (view(meta, now).readsBlocked) {
    throw new HttpError(503, 'Photo serving is paused until next month.', 'budget');
  }
}

/** True on a 1-in-READ_SAMPLE_RATE basis. Cheap, unbiased, and crucially costs no D1
 *  write on the other 99 reads. */
export function shouldSampleRead(): boolean {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return buf[0] % READ_SAMPLE_RATE === 0;
}

/** The increment to apply when a sampled read fires. */
export const READ_SAMPLE_WEIGHT = READ_SAMPLE_RATE;

/** Roll the per-day and per-month counters forward. Returns the values to persist.
 *  Pure so it can be unit-tested without a database. */
export function rollCounters(
  meta: AppMeta,
  now: number,
): { usage_day: number; uploads_today: number; reads_month: number; r2_reads_est: number } {
  const day = epochDay(now);
  const month = epochMonth(now);
  return {
    usage_day: day,
    uploads_today: day === meta.usage_day ? meta.uploads_today : 0,
    reads_month: month,
    r2_reads_est: month === meta.reads_month ? meta.r2_reads_est : 0,
  };
}
