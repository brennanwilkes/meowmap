// The R2 cost breaker. This is the code standing between the app and a bill, so it is
// tested harder than anything else in the Worker.
//   node --test --experimental-strip-types test/
//
// Runs without node_modules: budget.ts has no runtime imports beyond constants and a
// plain error class, and @cloudflare/workers-types is types-only, so stripping erases it.

import { test } from 'node:test';
import assert from 'node:assert';
import {
  assertReadAllowed, assertUploadAllowed, epochDay, epochMonth, rollCounters, view,
} from '../src/budget.ts';
import { R2_BYTE_CEILING, R2_READ_CEILING, UPLOADS_PER_DAY } from '../src/constants.ts';
import { HttpError } from '../src/types.ts';
import type { AppMeta } from '../src/types.ts';

const NOW = Date.UTC(2026, 8, 10, 12, 0, 0);

function meta(over: Partial<AppMeta> = {}): AppMeta {
  return {
    data_version: 1,
    r2_bytes: 0,
    r2_objects: 0,
    r2_reads_est: 0,
    usage_day: epochDay(NOW),
    uploads_today: 0,
    reads_month: epochMonth(NOW),
    ...over,
  };
}

test('an empty budget allows an upload', () => {
  assert.doesNotThrow(() => assertUploadAllowed(meta(), NOW, 550_000));
});

test('storage refuses BEFORE crossing the ceiling, not after', () => {
  // The whole point: fail closed while there is still headroom, because R2 bills rather
  // than failing closed on its own and there is no native spend cap to fall back on.
  const nearlyFull = meta({ r2_bytes: R2_BYTE_CEILING - 100 });
  assert.throws(() => assertUploadAllowed(nearlyFull, NOW, 550_000), (e: unknown) => {
    assert.ok(e instanceof HttpError);
    assert.strictEqual(e.status, 507);
    assert.strictEqual(e.outcome, 'budget');
    return true;
  });
});

test('the refusal tells her the photo is safe, not just that it failed', () => {
  // Failing closed must not also mean losing her photo — capture= photos never reach the
  // camera roll, so the outbox is the only copy.
  try {
    assertUploadAllowed(meta({ r2_bytes: R2_BYTE_CEILING }), NOW, 1);
    assert.fail('expected a throw');
  } catch (e) {
    assert.ok(e instanceof HttpError);
    assert.match(e.message, /saved on this phone/i);
  }
});

test('an exactly-fitting upload is allowed', () => {
  const m = meta({ r2_bytes: R2_BYTE_CEILING - 1000 });
  assert.doesNotThrow(() => assertUploadAllowed(m, NOW, 1000));
  assert.throws(() => assertUploadAllowed(m, NOW, 1001), HttpError);
});

test('the daily upload cap trips at the limit', () => {
  assert.doesNotThrow(() => assertUploadAllowed(meta({ uploads_today: UPLOADS_PER_DAY - 1 }), NOW, 1));
  assert.throws(() => assertUploadAllowed(meta({ uploads_today: UPLOADS_PER_DAY }), NOW, 1), HttpError);
});

test("yesterday's uploads do not count against today", () => {
  const stale = meta({ usage_day: epochDay(NOW) - 1, uploads_today: UPLOADS_PER_DAY + 50 });
  assert.doesNotThrow(() => assertUploadAllowed(stale, NOW, 1));
  assert.strictEqual(view(stale, NOW).uploadsToday, 0);
});

test("last month's reads do not count against this month", () => {
  const stale = meta({ reads_month: epochMonth(NOW) - 1, r2_reads_est: R2_READ_CEILING * 2 });
  assert.doesNotThrow(() => assertReadAllowed(stale, NOW));
  assert.strictEqual(view(stale, NOW).readsEstimated, 0);
});

test('photo reads are paused over the ceiling, and only photo reads', () => {
  const hot = meta({ r2_reads_est: R2_READ_CEILING });
  assert.throws(() => assertReadAllowed(hot, NOW), (e: unknown) => {
    assert.ok(e instanceof HttpError);
    // 503 not 507: the app still works, images are just unavailable. Taking the whole
    // map down to protect a photo bill would be the wrong trade.
    assert.strictEqual(e.status, 503);
    return true;
  });
  assert.doesNotThrow(() => assertUploadAllowed(hot, NOW, 1000), 'uploads are a separate budget');
});

test('rollCounters resets on a day boundary and preserves within one', () => {
  const m = meta({ uploads_today: 5 });
  assert.strictEqual(rollCounters(m, NOW).uploads_today, 5);
  const tomorrow = NOW + 86_400_000;
  assert.strictEqual(rollCounters(m, tomorrow).uploads_today, 0);
  assert.strictEqual(rollCounters(m, tomorrow).usage_day, epochDay(tomorrow));
});

test('epochMonth rolls at a real month boundary', () => {
  assert.strictEqual(epochMonth(Date.UTC(2026, 8, 30, 23, 59)), epochMonth(Date.UTC(2026, 8, 1)));
  assert.notStrictEqual(epochMonth(Date.UTC(2026, 8, 30)), epochMonth(Date.UTC(2026, 9, 1)));
});

test('view reports every ceiling for GET /health', () => {
  const v = view(meta({ r2_bytes: 1_000, r2_objects: 3, uploads_today: 2, r2_reads_est: 400 }), NOW);
  assert.deepStrictEqual(
    { b: v.bytesUsed, o: v.objects, u: v.uploadsToday, r: v.readsEstimated },
    { b: 1_000, o: 3, u: 2, r: 400 },
  );
  assert.strictEqual(v.bytesCeiling, R2_BYTE_CEILING);
  assert.strictEqual(v.storageBlocked, false);
  assert.strictEqual(v.uploadsBlocked, false);
  assert.strictEqual(v.readsBlocked, false);
});
