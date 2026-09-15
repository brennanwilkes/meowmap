import type {
  AppMeta, CatDto, CatRow, Env, PhotoVariant, SightingDto, SightingRow,
} from './types.ts';
import { HttpError } from './types.ts';
import { JPEG_CT, PHOTO_CACHE_CONTROL } from './constants.ts';
import { epochDay, epochMonth } from './budget.ts';

/* The ONLY module that touches D1 or R2.
 *
 * Every statement uses numbered placeholders (?1, ?2 …) and .bind(). Never interpolate
 * into SQL — note that free-text `note` and `name` come straight from a public endpoint. */

/* ── keys ──────────────────────────────────────────────────────────────────── */

export async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Flat namespace, no extension: the content type lives in R2 httpMetadata where it is
 *  authoritative, rather than being inferred from a string. R2's keyspace is flat and has
 *  no prefix hot-spotting, so sharding would only make list-based GC harder. */
export function photoKey(hash: string): string {
  return `photos/${hash}`;
}

const HEX64 = /^[0-9a-f]{64}$/;
export function assertHash(hash: string): string {
  if (!HEX64.test(hash)) throw new HttpError(400, 'Bad photo id');
  return hash;
}

/* ── app_meta ──────────────────────────────────────────────────────────────── */

export async function getMeta(env: Env): Promise<AppMeta> {
  const row = await env.MEOWMAP_DB
    .prepare(
      `SELECT data_version, r2_bytes, r2_objects, r2_reads_est,
              usage_day, uploads_today, reads_month
         FROM app_meta WHERE id = 1`,
    )
    .first<AppMeta>();
  // Seeded by 001_initial.sql. Missing means the migration did not run — surface it
  // rather than inventing zeroes, which would silently disarm the cost breaker.
  if (row === null) throw new Error('app_meta row 1 missing — did migrations run?');
  return row;
}

/** One statement that bumps data_version and rolls/increments the R2 counters. Folding
 *  them into a single row is what keeps a sighting upload at 4 rows written rather than 5. */
export function bumpMeta(
  env: Env,
  now: number,
  delta: { bytes?: number; objects?: number; uploads?: number; reads?: number } = {},
): D1PreparedStatement {
  const day = epochDay(now);
  const month = epochMonth(now);
  return env.MEOWMAP_DB
    .prepare(
      `UPDATE app_meta SET
         data_version  = data_version + 1,
         r2_bytes      = r2_bytes   + ?1,
         r2_objects    = r2_objects + ?2,
         uploads_today = CASE WHEN usage_day  = ?4 THEN uploads_today ELSE 0 END + ?3,
         usage_day     = ?4,
         r2_reads_est  = CASE WHEN reads_month = ?6 THEN r2_reads_est ELSE 0 END + ?5,
         reads_month   = ?6,
         updated_at    = ?7
       WHERE id = 1`,
    )
    .bind(
      delta.bytes ?? 0, delta.objects ?? 0, delta.uploads ?? 0,
      day, delta.reads ?? 0, month, now,
    );
}

/** Reads must not bump data_version — that would invalidate every client's ETag on every
 *  hundredth photo view and turn cheap 304s into full table scans. */
export function addSampledRead(env: Env, now: number, weight: number): D1PreparedStatement {
  const month = epochMonth(now);
  return env.MEOWMAP_DB
    .prepare(
      `UPDATE app_meta SET
         r2_reads_est = CASE WHEN reads_month = ?1 THEN r2_reads_est ELSE 0 END + ?2,
         reads_month  = ?1,
         updated_at   = ?3
       WHERE id = 1`,
    )
    .bind(month, weight, now);
}

/* ── reads ─────────────────────────────────────────────────────────────────── */

export async function getDataVersion(env: Env): Promise<number> {
  const row = await env.MEOWMAP_DB
    .prepare('SELECT data_version FROM app_meta WHERE id = 1')
    .first<{ data_version: number }>();
  if (row === null) throw new Error('app_meta row 1 missing — did migrations run?');
  return row.data_version;
}

/** The whole dataset in one shot. The client needs it all for offline anyway, which is
 *  why this schema has no spatial index and no viewport queries. No ORDER BY: rowid order
 *  is free and the client sorts. */
export async function getBulk(env: Env): Promise<{ cats: CatDto[]; sightings: SightingDto[] }> {
  const [catsRes, sightRes] = await env.MEOWMAP_DB.batch<CatRow | SightingRow>([
    env.MEOWMAP_DB.prepare(
      `SELECT id, name, notes, coat, size, created_at, updated_at
         FROM cats WHERE deleted_at IS NULL`,
    ),
    env.MEOWMAP_DB.prepare(
      `SELECT id, client_id, cat_id, lat, lon, location_source, accuracy_m, seen_at,
              note, photo_full, photo_thumb, photo_w, photo_h, petted,
              created_at, updated_at
         FROM sightings WHERE deleted_at IS NULL`,
    ),
  ]);
  return {
    cats: (catsRes.results as CatRow[]).map(toCatDto),
    sightings: (sightRes.results as SightingRow[]).map(toSightingDto),
  };
}

export async function getSightingById(env: Env, id: number): Promise<SightingRow | null> {
  return await env.MEOWMAP_DB
    .prepare('SELECT * FROM sightings WHERE id = ?1 AND deleted_at IS NULL')
    .bind(id)
    .first<SightingRow>();
}

export async function getSightingByClientId(env: Env, clientId: string): Promise<SightingRow | null> {
  return await env.MEOWMAP_DB
    .prepare('SELECT * FROM sightings WHERE client_id = ?1')
    .bind(clientId)
    .first<SightingRow>();
}

/* ── mappers ───────────────────────────────────────────────────────────────── */

export function toCatDto(r: CatRow): CatDto {
  return {
    id: r.id, name: r.name, notes: r.notes,
    coat: r.coat === null || r.coat === '' ? [] : r.coat.split(','),
    size: r.size as CatDto['size'],
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

export function toSightingDto(r: SightingRow): SightingDto {
  return {
    id: r.id,
    // Must always be present: the offline client dedupes pending pins against it.
    clientId: r.client_id,
    catId: r.cat_id,
    lat: r.lat,
    lon: r.lon,
    locationSource: r.location_source as SightingDto['locationSource'],
    accuracyM: r.accuracy_m,
    seenAt: r.seen_at,
    note: r.note,
    photoFull: r.photo_full,
    photoThumb: r.photo_thumb,
    photoW: r.photo_w,
    photoH: r.photo_h,
    petted: r.petted as SightingDto['petted'],
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/* ── R2 ────────────────────────────────────────────────────────────────────── */

export interface PutResult { hash: string; size: number; deduped: boolean }

/**
 * head() before put() is a deliberate cost trade: HeadObject is class B (10M/mo free),
 * PutObject is class A (1M/mo free), so checking is ~12x cheaper than blind writing.
 * It also makes retries free and tells the caller whether to charge the byte budget.
 */
export async function putPhoto(
  env: Env, variant: PhotoVariant, bytes: ArrayBuffer, deviceId: string, now: number,
): Promise<PutResult> {
  const hash = await sha256Hex(bytes);
  const key = photoKey(hash);

  const existing = await env.PHOTOS.head(key);
  if (existing !== null) return { hash, size: existing.size, deduped: true };

  await env.PHOTOS.put(key, bytes, {
    // Set at write time so serving is a two-liner that cannot drift from what was stored.
    httpMetadata: { contentType: JPEG_CT, cacheControl: PHOTO_CACHE_CONTROL },
    customMetadata: { variant, deviceId, uploadedAt: String(now) },
  });
  return { hash, size: bytes.byteLength, deduped: false };
}

/** Passing the request headers lets R2 evaluate If-None-Match itself; on a failed
 *  precondition it returns an object whose `body` is undefined. */
export async function getPhoto(env: Env, hash: string, req: Request): Promise<R2ObjectBody | R2Object | null> {
  return await env.PHOTOS.get(photoKey(hash), { onlyIf: req.headers });
}

/* ── writes ────────────────────────────────────────────────────────────────── */

export interface NewSighting {
  clientId: string;
  catId: number | null;
  lat: number;
  lon: number;
  locationSource: string;
  accuracyM: number | null;
  seenAt: number;
  note: string | null;
  photoFull: string;
  photoThumb: string;
  photoW: number;
  photoH: number;
  /* Per-encounter since 004, and the only tag that is: it is stamped on the polaroid, so
   * it has to be about THAT photo. Coat and size stay on the cat. */
  petted: string | null;
  deviceId: string;
}

/** ON CONFLICT DO NOTHING makes a retried offline upload a no-op rather than a duplicate.
 *  The caller checks for zero rows and returns the existing sighting with duplicate:true,
 *  which the client treats exactly like a fresh 201. */
export function insertSighting(env: Env, s: NewSighting, now: number): D1PreparedStatement {
  return env.MEOWMAP_DB
    .prepare(
      `INSERT INTO sightings
         (client_id, cat_id, lat, lon, location_source, accuracy_m, seen_at,
          note, photo_full, photo_thumb, photo_w, photo_h, petted,
          device_id, created_at, updated_at)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?15)
       ON CONFLICT(client_id) DO NOTHING`,
    )
    .bind(
      s.clientId, s.catId, s.lat, s.lon, s.locationSource, s.accuracyM, s.seenAt,
      s.note, s.photoFull, s.photoThumb, s.photoW, s.photoH, s.petted,
      s.deviceId, now,
    );
}

/** COALESCE(?n, col) so an absent field leaves the stored value alone rather than
 *  nulling it — a PATCH that only moves the pin must not wipe her note. */
export function patchSighting(
  env: Env, id: number, p: Partial<NewSighting>, now: number,
): D1PreparedStatement {
  return env.MEOWMAP_DB
    .prepare(
      `UPDATE sightings SET
         cat_id          = CASE WHEN ?2 = 1 THEN ?3 ELSE cat_id END,
         lat             = COALESCE(?4, lat),
         lon             = COALESCE(?5, lon),
         location_source = COALESCE(?6, location_source),
         accuracy_m      = CASE WHEN ?7 = 1 THEN ?8 ELSE accuracy_m END,
         seen_at         = COALESCE(?9, seen_at),
         note            = COALESCE(?10, note),
         petted          = CASE WHEN ?11 = 1 THEN ?12 ELSE petted END,
         updated_at      = ?13
       WHERE id = ?1 AND deleted_at IS NULL`,
    )
    .bind(
      id,
      // cat_id and accuracy_m are legitimately settable to NULL (unlink a cat; hand-place
      // a pin), so they need an explicit "was this field present?" flag rather than
      // COALESCE, which cannot tell absent from null.
      p.catId === undefined ? 0 : 1, p.catId ?? null,
      p.lat ?? null, p.lon ?? null, p.locationSource ?? null,
      p.accuracyM === undefined ? 0 : 1, p.accuracyM ?? null,
      p.seenAt ?? null, p.note ?? null,
      // Un-answering "did you pet them" is a real edit, so it needs the flag too.
      p.petted === undefined ? 0 : 1, p.petted ?? null,
      now,
    );
}

export function softDeleteSighting(env: Env, id: number, now: number): D1PreparedStatement {
  return env.MEOWMAP_DB
    .prepare('UPDATE sightings SET deleted_at = ?2, updated_at = ?2 WHERE id = ?1 AND deleted_at IS NULL')
    .bind(id, now);
}

export function slugify(name: string): string {
  return name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/** What a cat actually holds. Every field optional so the same shape serves the insert
 *  (absent = not given) and the patch (absent = leave alone). */
export interface CatFields {
  name?: string | null;
  notes?: string | null;
  coat?: string[];
  size?: string | null;
}

/** Sorted and comma-joined, so the stored string is canonical and two cats tagged the
 *  same way compare equal. Empty is stored as NULL, never ''. */
function coatColumn(coat: string[] | undefined): string | null {
  if (coat === undefined || coat.length === 0) return null;
  return [...coat].sort().join(',');
}

export function insertCat(env: Env, c: CatFields, now: number): D1PreparedStatement {
  const name = c.name ?? null;
  return env.MEOWMAP_DB
    .prepare(
      `INSERT INTO cats (name, slug, notes, coat, size, created_at, updated_at)
       VALUES (?1,?2,?3,?4,?5,?6,?6)`,
    )
    .bind(
      name, name === null ? null : slugify(name), c.notes ?? null,
      coatColumn(c.coat), c.size ?? null, now,
    );
}

export function patchCat(env: Env, id: number, c: CatFields, now: number): D1PreparedStatement {
  const { name } = c;
  return env.MEOWMAP_DB
    .prepare(
      `UPDATE cats SET
         name       = CASE WHEN ?2 = 1 THEN ?3 ELSE name END,
         slug       = CASE WHEN ?2 = 1 THEN ?4 ELSE slug END,
         notes      = COALESCE(?5, notes),
         coat       = CASE WHEN ?6 = 1 THEN ?7 ELSE coat END,
         size       = CASE WHEN ?8 = 1 THEN ?9 ELSE size END,
         updated_at = ?10
       WHERE id = ?1 AND deleted_at IS NULL`,
    )
    .bind(
      id, name === undefined ? 0 : 1, name ?? null,
      name === undefined || name === null ? null : slugify(name),
      c.notes ?? null,
      /* Clearing every chip is a real edit, so these need the present/absent flag rather
       * than COALESCE — which cannot tell "not sent" from "set to nothing" and would make
       * un-tagging a cat impossible. */
      c.coat === undefined ? 0 : 1, coatColumn(c.coat),
      c.size === undefined ? 0 : 1, c.size ?? null,
      now,
    );
}

/** Deleting a cat must not delete her photos — its sightings revert to unidentified,
 *  which is a normal state rather than an error. */
export function softDeleteCat(env: Env, id: number, now: number): D1PreparedStatement[] {
  return [
    env.MEOWMAP_DB
      .prepare('UPDATE cats SET deleted_at = ?2, updated_at = ?2 WHERE id = ?1 AND deleted_at IS NULL')
      .bind(id, now),
    env.MEOWMAP_DB
      .prepare('UPDATE sightings SET cat_id = NULL, updated_at = ?2 WHERE cat_id = ?1')
      .bind(id, now),
  ];
}

export async function catExists(env: Env, id: number): Promise<boolean> {
  const row = await env.MEOWMAP_DB
    .prepare('SELECT 1 AS ok FROM cats WHERE id = ?1 AND deleted_at IS NULL')
    .bind(id)
    .first<{ ok: number }>();
  return row !== null;
}
