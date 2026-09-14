import type { Env, PhotoVariant } from './types.ts';
import { HttpError } from './types.ts';
import {
  BULK_CACHE_CONTROL, CONFIG_CACHE_CONTROL, FULL_LONG_EDGE, FULL_MAX_BYTES,
  JPEG_CT, MAX_PHOTO_BYTES, PHOTO_CACHE_CONTROL, THUMB_LONG_EDGE, THUMB_MAX_BYTES,
} from './constants.ts';
import { corsHeaders, handleOptions } from './cors.ts';
import { errorJson, json, noContent, notModified } from './http.ts';
import { maybeRenew, requirePass } from './auth.ts';
import { verifyTurnstile } from './turnstile.ts';
import { auditStatement, type AuditFields } from './audit.ts';
import * as budget from './budget.ts';
import * as db from './storage.ts';
import {
  coatTags, int, lat, lon, optId, optStr, photoDim, readJson, seenAt, uuid, validators,
} from './validate.ts';

/* Routes only. No business logic here, no Response constructed here (see http.ts), no
 * D1 or R2 touched here (see storage.ts). */

const ROUTE_SIGHTING = /^\/sightings\/(\d+)$/;
const ROUTE_CAT = /^\/cats\/(\d+)$/;
const ROUTE_PHOTO = /^\/photo\/([0-9a-f]{64})$/;

function clientIp(req: Request): string {
  return req.headers.get('CF-Connecting-IP') ?? 'unknown';
}

/** Rate limiters are per-colo and eventually consistent — a blunt floodgate, not an
 *  accounting system. Never rely on one for correctness. */
async function limit(rl: RateLimit, key: string): Promise<void> {
  const { success } = await rl.limit({ key });
  if (!success) throw new HttpError(429, 'Too many requests. Try again in a minute.', 'invalid');
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const now = Date.now();
    const audits: AuditFields[] = [];

    // Only ever audit a request that got past auth; see audit.ts for why. `audits` is
    // empty until then, which is what makes this safe to call unconditionally.
    // EXACTLY ONE row, always the LAST pushed. A placeholder goes in the moment auth
    // passes so a failure still has something to write; a handler then pushes the
    // specific entry. Writing both would cost two rows per upload and break the budget
    // this project is built around (4 rows/upload against a hard 100k/day cap).
    const writeAudit = (over: Partial<AuditFields>) => {
      if (audits.length === 0) return;
      const f = audits[audits.length - 1];
      ctx.waitUntil(
        env.MEOWMAP_DB.batch([auditStatement(env, req, now, { ...f, ...over })])
          .then(() => undefined)
          .catch((e) => console.error('[audit] failed:', e)),
      );
    };

    try {
      const res = await route(req, env, ctx, path, now, audits);
      // Successes are audited too. Without this the log only ever held /pass rows, so
      // "did this upload reach the server, and what did it do" was unanswerable — which
      // is the entire reason the table exists.
      writeAudit({});
      return res;
    } catch (err) {
      if (err instanceof HttpError) {
        writeAudit({ status: err.status, outcome: err.outcome });
        return errorJson(req, env, err.status, err.message);
      }
      // An unhandled error is the MOST important thing to record, not the least: it is
      // the only failure mode with no status code to explain itself to the client.
      console.error('[fetch] unhandled:', err);
      writeAudit({
        status: 500,
        outcome: 'internal',
        detail: err instanceof Error ? err.message.slice(0, 300) : String(err).slice(0, 300),
      });
      // Never leak internal error text to a public client.
      return errorJson(req, env, 500, 'Internal error');
    }
  },
};

async function route(
  req: Request, env: Env, ctx: ExecutionContext, path: string, now: number, audits: AuditFields[],
): Promise<Response> {
  if (req.method === 'OPTIONS') return handleOptions(req, env);

  /* ── public reads ─────────────────────────────────────────────────────── */

  if (path === '/health' && req.method === 'GET') {
    const meta = await db.getMeta(env);
    return json(req, env, 200, { ok: true, version: meta.data_version, budget: budget.view(meta, now) });
  }

  if (path === '/config' && req.method === 'GET') {
    return json(req, env, 200, {
      turnstileSiteKey: env.TURNSTILE_SITE_KEY,
      passTtlDays: Number(env.PASS_TTL_DAYS),
      maxPhotoBytes: MAX_PHOTO_BYTES,
      full: { longEdge: FULL_LONG_EDGE, maxBytes: FULL_MAX_BYTES },
      thumb: { longEdge: THUMB_LONG_EDGE, maxBytes: THUMB_MAX_BYTES },
    }, { 'Cache-Control': CONFIG_CACHE_CONTROL });
  }

  if (path === '/sightings' && req.method === 'GET') {
    // Photo keys are unguessable SHA-256, so scraping them requires this endpoint first.
    // Throttling it is what makes a class B bill expensive to inflict.
    await limit(env.RL_BULK_IP, clientIp(req));

    const version = await db.getDataVersion(env);
    const etag = `W/"v${version}"`;
    // A warm client costs ONE row read instead of a full table scan. This is the single
    // most important read optimisation in the app.
    if (req.headers.get('If-None-Match') === etag) {
      return notModified(req, env, etag, BULK_CACHE_CONTROL);
    }
    const { cats, sightings } = await db.getBulk(env);
    return json(req, env, 200, { version, cats, sightings }, {
      'Cache-Control': BULK_CACHE_CONTROL,
      'ETag': etag,
      'Cache-Tag': 'sightings',
    });
  }

  const photoMatch = path.match(ROUTE_PHOTO);
  if (photoMatch !== null && req.method === 'GET') {
    return await servePhoto(req, env, ctx, photoMatch[1], now);
  }

  /* ── the pass ─────────────────────────────────────────────────────────── */

  if (path === '/pass' && req.method === 'POST') {
    // Pre-auth, so deliberately NOT audited: an audit row here would be a
    // write-amplification DoS against the D1 daily cap.
    await limit(env.RL_PASS_IP, clientIp(req));
    const body = await readJson(req);
    const deviceId = uuid(body.deviceId, 'deviceId');
    const token = optStr(body.token, 'token', 4096);
    if (token === null) throw new HttpError(400, 'Bad request');

    await verifyTurnstile(env, token, req.headers.get('CF-Connecting-IP'));

    const { issuePass } = await import('./auth.ts');
    const pass = await issuePass(env, deviceId, now);
    ctx.waitUntil(
      env.MEOWMAP_DB
        .batch([auditStatement(env, req, now, {
          method: 'POST', path: '/pass', status: 200, outcome: 'pass_issued', deviceId,
        })])
        .then(() => undefined)
        .catch((e) => console.error('[audit] failed:', e)),
    );
    return json(req, env, 200, { pass, expiresAt: now + Number(env.PASS_TTL_DAYS) * 86_400_000 });
  }

  /* ── everything below mutates ─────────────────────────────────────────────
   * Check order is load-bearing. Steps 1-3 are pure compute with ZERO D1 writes,
   * so an unauthenticated request can never consume the daily write budget — which
   * since 2026-09-01 is a hard, day-long outage rather than a soft limit. */

  const mutating = req.method === 'POST' || req.method === 'PATCH' || req.method === 'DELETE';
  if (!mutating) throw new HttpError(404, 'Not found', 'notfound');

  await limit(env.RL_MUTATE_IP, clientIp(req));            // 1
  const pass = await requirePass(env, req, now);           // 2 (+ typ check inside)
  await limit(env.RL_MUTATE_DEVICE, pass.sub);             // 3

  audits.push({ method: req.method, path, status: 0, outcome: 'error', passSub: pass.sub, passIat: pass.iat ?? null });
  const renewed = await maybeRenew(env, pass, now);
  const extra: Record<string, string> = renewed === null ? {} : { 'X-Pass-Renewed': renewed };

  if (path === '/photo' && req.method === 'POST') {
    return await uploadPhoto(req, env, now, pass.sub, extra, audits);
  }
  if (path === '/sightings' && req.method === 'POST') {
    return await createSighting(req, env, now, pass.sub, extra, audits);
  }

  const sMatch = path.match(ROUTE_SIGHTING);
  if (sMatch !== null) {
    const id = Number(sMatch[1]);
    if (req.method === 'PATCH') return await updateSighting(req, env, now, id, extra, audits);
    if (req.method === 'DELETE') return await deleteSighting(req, env, now, id, extra, audits);
  }

  if (path === '/cats' && req.method === 'POST') {
    return await createCat(req, env, now, extra, audits);
  }
  const cMatch = path.match(ROUTE_CAT);
  if (cMatch !== null) {
    const id = Number(cMatch[1]);
    if (req.method === 'PATCH') return await updateCat(req, env, now, id, extra, audits);
    if (req.method === 'DELETE') return await deleteCat(req, env, now, id, extra, audits);
  }

  throw new HttpError(404, 'Not found', 'notfound');
}

/* ── photo serving ─────────────────────────────────────────────────────────── */

async function servePhoto(
  req: Request, env: Env, ctx: ExecutionContext, hash: string, now: number,
): Promise<Response> {
  const meta = await db.getMeta(env);
  budget.assertReadAllowed(meta, now);

  const obj = await db.getPhoto(env, hash, req);
  if (obj === null) throw new HttpError(404, 'Not found', 'notfound');

  // Sampled, because an exact counter would cost a D1 write per photo view — spending
  // the D1 budget to protect the R2 one. Only cold reads ever reach here: a Workers
  // Cache hit never invokes the Worker and an immutable browser hit never leaves the
  // phone, which is exactly the traffic that does not need policing.
  if (budget.shouldSampleRead()) {
    ctx.waitUntil(
      db.addSampledRead(env, now, budget.READ_SAMPLE_WEIGHT).run()
        .then(() => undefined)
        .catch((e) => console.error('[budget] sampled read failed:', e)),
    );
  }

  const headers = new Headers(corsHeaders(req, env));
  obj.writeHttpMetadata(headers);           // contentType + cacheControl set at put time
  headers.set('ETag', obj.httpEtag);
  headers.set('Cache-Tag', 'photos');
  if (!headers.has('Content-Type')) headers.set('Content-Type', JPEG_CT);
  if (!headers.has('Cache-Control')) headers.set('Cache-Control', PHOTO_CACHE_CONTROL);

  // R2 evaluated If-None-Match itself; a failed precondition returns no body.
  const body = (obj as R2ObjectBody).body;
  if (body === undefined || body === null) return new Response(null, { status: 304, headers });
  return new Response(body, { headers });   // streamed, never buffered
}

/* ── mutations ─────────────────────────────────────────────────────────────── */

async function uploadPhoto(
  req: Request, env: Env, now: number, deviceId: string,
  extra: Record<string, string>, audits: AuditFields[],
): Promise<Response> {
  const url = new URL(req.url);
  const variant = url.searchParams.get('variant');
  if (variant !== 'full' && variant !== 'thumb') {
    throw new HttpError(400, 'variant must be full or thumb');
  }

  // Reject before reading the body so a client bug cannot burn CPU on a huge upload.
  const declared = Number(req.headers.get('Content-Length') ?? '0');
  if (declared > MAX_PHOTO_BYTES) throw new HttpError(413, 'Photo too large');

  const meta = await db.getMeta(env);
  budget.assertUploadAllowed(meta, now, declared);

  const bytes = await req.arrayBuffer();
  if (bytes.byteLength > MAX_PHOTO_BYTES) throw new HttpError(413, 'Photo too large');
  if (bytes.byteLength === 0) throw new HttpError(400, 'Empty body');

  const put = await db.putPhoto(env, variant as PhotoVariant, bytes, deviceId, now);

  // Charge the budget only for genuinely new bytes. A re-upload of identical content
  // lands on the same content-addressed key and must not consume the ceiling.
  if (!put.deduped) {
    await env.MEOWMAP_DB.batch([bumpFor(env, now, put.size)]);
  }

  audits.push({
    method: 'POST', path: '/photo', status: 201, outcome: 'ok',
    deviceId, bytesIn: bytes.byteLength, detail: put.deduped ? 'dedup' : variant,
  });
  return json(req, env, 201, { hash: put.hash, size: put.size, dedup: put.deduped }, extra);
}

function bumpFor(env: Env, now: number, bytes: number): D1PreparedStatement {
  return db.bumpMeta(env, now, { bytes, objects: 1, uploads: 1 });
}

async function createSighting(
  req: Request, env: Env, now: number, deviceId: string,
  extra: Record<string, string>, audits: AuditFields[],
): Promise<Response> {
  const b = await readJson(req);
  const clientId = uuid(b.clientId, 'clientId');
  const catId = optId(b.catId, 'catId') ?? null;
  if (catId !== null && !(await db.catExists(env, catId))) {
    throw new HttpError(400, 'catId does not exist');
  }

  const s: db.NewSighting = {
    clientId,
    catId,
    lat: lat(b.lat),
    lon: lon(b.lon),
    locationSource: validators.locationSource(b.locationSource),
    accuracyM: b.accuracyM === undefined || b.accuracyM === null
      ? null : int(b.accuracyM, 'accuracyM', 0, 100_000),
    seenAt: seenAt(b.seenAt, now),
    coat: coatTags(b.coat, 'coat') ?? [],
    size: validators.size(b.size) ?? null,
    petted: validators.petted(b.petted) ?? null,
    note: validators.note(b.note),
    photoFull: db.assertHash(String(b.photoFull ?? '')),
    photoThumb: db.assertHash(String(b.photoThumb ?? '')),
    photoW: photoDim(b.photoW, 'photoW'),
    photoH: photoDim(b.photoH, 'photoH'),
    deviceId,
  };

  /* EVERY SIGHTING BELONGS TO A CAT. If the client did not name one, mint an unnamed cat
   * for it here.
   *
   * The original model left cat_id NULL until she linked photos, and "not identified
   * yet" was meant to be a comfortable resting state. On the phone it was not: a fresh
   * upload had no colour, no territory and no page of its own, and the only way to give
   * it one was to open the Cats tab and tell the app a photo was the same cat as itself.
   *
   * Linking now means MERGING two cats, which is the operation she was really doing all
   * along. Cost is one extra row written per upload (4 -> 5 against the 100k/day cap),
   * which buys every sighting an identity from the moment it lands. */
  if (s.catId === null) {
    const cat = await db.insertCat(env, null, null, now).run();
    const newId = Number(cat.meta?.last_row_id ?? -1);
    if (newId < 0) throw new Error('auto cat insert returned no id');
    s.catId = newId;
  }

  const [insert] = await env.MEOWMAP_DB.batch([
    db.insertSighting(env, s, now),
    db.bumpMeta(env, now),
  ]);

  const existing = await db.getSightingByClientId(env, clientId);
  if (existing === null) throw new Error('insert reported success but the row is missing');

  // Zero changes means ON CONFLICT DO NOTHING fired: a retried offline upload. The client
  // treats this identically to a fresh 201, which is what makes the queue safe to retry.
  const duplicate = (insert.meta?.changes ?? 0) === 0;

  audits.push({
    method: 'POST', path: '/sightings', status: duplicate ? 200 : 201, outcome: 'ok',
    deviceId, targetId: existing.id, detail: duplicate ? 'duplicate' : null,
  });
  return json(req, env, duplicate ? 200 : 201, {
    sighting: db.toSightingDto(existing), duplicate,
  }, extra);
}

async function updateSighting(
  req: Request, env: Env, now: number, id: number,
  extra: Record<string, string>, audits: AuditFields[],
): Promise<Response> {
  const current = await db.getSightingById(env, id);
  if (current === null) throw new HttpError(404, 'Sighting not found', 'notfound');

  const b = await readJson(req);
  const catId = optId(b.catId, 'catId');
  if (catId !== undefined && catId !== null && !(await db.catExists(env, catId))) {
    throw new HttpError(400, 'catId does not exist');
  }

  const patch: Partial<db.NewSighting> = {};
  if (catId !== undefined) patch.catId = catId;
  if (b.lat !== undefined) patch.lat = lat(b.lat);
  if (b.lon !== undefined) patch.lon = lon(b.lon);
  if (b.locationSource !== undefined) patch.locationSource = validators.locationSource(b.locationSource);
  if (b.accuracyM !== undefined) {
    patch.accuracyM = b.accuracyM === null ? null : int(b.accuracyM, 'accuracyM', 0, 100_000);
  }
  if (b.seenAt !== undefined) patch.seenAt = seenAt(b.seenAt, now);
  const coat = coatTags(b.coat, 'coat');
  if (coat !== undefined) patch.coat = coat;
  const size = validators.size(b.size);
  if (size !== undefined) patch.size = size;
  const petted = validators.petted(b.petted);
  if (petted !== undefined) patch.petted = petted;
  if (b.note !== undefined) patch.note = validators.note(b.note);

  await env.MEOWMAP_DB.batch([db.patchSighting(env, id, patch, now), db.bumpMeta(env, now)]);
  const updated = await db.getSightingById(env, id);
  if (updated === null) throw new Error('row vanished mid-update');

  audits.push({ method: 'PATCH', path: '/sightings/:id', status: 200, outcome: 'ok', targetId: id });
  return json(req, env, 200, { sighting: db.toSightingDto(updated) }, extra);
}

async function deleteSighting(
  req: Request, env: Env, now: number, id: number,
  extra: Record<string, string>, audits: AuditFields[],
): Promise<Response> {
  const current = await db.getSightingById(env, id);
  if (current === null) throw new HttpError(404, 'Sighting not found', 'notfound');
  await env.MEOWMAP_DB.batch([db.softDeleteSighting(env, id, now), db.bumpMeta(env, now)]);
  audits.push({ method: 'DELETE', path: '/sightings/:id', status: 204, outcome: 'ok', targetId: id });
  void extra;   // 204 carries no headers worth renewing a pass on
  return noContent(req, env);
}

async function createCat(
  req: Request, env: Env, now: number, extra: Record<string, string>, audits: AuditFields[],
): Promise<Response> {
  const b = await readJson(req);
  const name = validators.name(b.name);
  const notes = optStr(b.notes, 'notes', 500);
  const [ins] = await env.MEOWMAP_DB.batch([db.insertCat(env, name, notes, now), db.bumpMeta(env, now)]);
  const id = Number(ins.meta?.last_row_id ?? -1);
  if (id < 0) throw new Error('cat insert returned no id');
  audits.push({ method: 'POST', path: '/cats', status: 201, outcome: 'ok', targetId: id });
  return json(req, env, 201, {
    cat: { id, name, notes, createdAt: now, updatedAt: now },
  }, extra);
}

async function updateCat(
  req: Request, env: Env, now: number, id: number,
  extra: Record<string, string>, audits: AuditFields[],
): Promise<Response> {
  if (!(await db.catExists(env, id))) throw new HttpError(404, 'Cat not found', 'notfound');
  const b = await readJson(req);
  const name = b.name === undefined ? undefined : validators.name(b.name);
  const notes = b.notes === undefined ? undefined : optStr(b.notes, 'notes', 500);
  await env.MEOWMAP_DB.batch([db.patchCat(env, id, name, notes, now), db.bumpMeta(env, now)]);
  audits.push({ method: 'PATCH', path: '/cats/:id', status: 200, outcome: 'ok', targetId: id });
  return json(req, env, 200, { ok: true }, extra);
}

async function deleteCat(
  req: Request, env: Env, now: number, id: number,
  extra: Record<string, string>, audits: AuditFields[],
): Promise<Response> {
  if (!(await db.catExists(env, id))) throw new HttpError(404, 'Cat not found', 'notfound');
  // Its sightings revert to unidentified rather than being deleted — never destroy a
  // photo as a side effect of tidying up a name.
  await env.MEOWMAP_DB.batch([...db.softDeleteCat(env, id, now), db.bumpMeta(env, now)]);
  audits.push({ method: 'DELETE', path: '/cats/:id', status: 204, outcome: 'ok', targetId: id });
  void extra;
  return noContent(req, env);
}
