import { HttpError } from './types.ts';
import {
  COAT_TAGS, LOCATION_SOURCES, MAX_NAME_LEN, MAX_NOTE_LEN, MAX_PHOTO_DIM,
  PETTED_VALUES, SIZE_TAGS,
} from './constants.ts';

/* Every value here arrives from a public, unauthenticated-by-password endpoint. Anything
 * that fails validation THROWS — no coercion, no defaults. A silently-clamped coordinate
 * is a pin in the wrong place that nobody ever notices. */

export async function readJson(req: Request): Promise<Record<string, unknown>> {
  const ct = req.headers.get('Content-Type') ?? '';
  if (!ct.includes('application/json')) throw new HttpError(400, 'Expected application/json');
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    throw new HttpError(400, 'Body is not valid JSON');
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new HttpError(400, 'Body must be a JSON object');
  }
  return body as Record<string, unknown>;
}

export function str(v: unknown, field: string, max: number): string {
  if (typeof v !== 'string') throw new HttpError(400, `${field} must be a string`);
  const t = v.trim();
  if (t.length === 0) throw new HttpError(400, `${field} must not be empty`);
  if (t.length > max) throw new HttpError(400, `${field} must be ${max} characters or fewer`);
  return t;
}

export function optStr(v: unknown, field: string, max: number): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string') throw new HttpError(400, `${field} must be a string`);
  const t = v.trim();
  return t.length === 0 ? null : str(t, field, max);
}

export function num(v: unknown, field: string, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new HttpError(400, `${field} must be a finite number`);
  }
  if (v < min || v > max) throw new HttpError(400, `${field} must be between ${min} and ${max}`);
  return v;
}

export function int(v: unknown, field: string, min: number, max: number): number {
  const n = num(v, field, min, max);
  if (!Number.isInteger(n)) throw new HttpError(400, `${field} must be a whole number`);
  return n;
}

/** IDs can legitimately be 0, so this must distinguish absent from zero. Never use a
 *  falsy check on an id anywhere in this codebase. */
export function optId(v: unknown, field: string): number | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  return int(v, field, 0, Number.MAX_SAFE_INTEGER);
}

export function oneOf<T extends string>(v: unknown, field: string, allowed: readonly T[]): T {
  if (typeof v !== 'string' || !allowed.includes(v as T)) {
    throw new HttpError(400, `${field} must be one of: ${allowed.join(', ')}`);
  }
  return v as T;
}

export function optOneOf<T extends string>(
  v: unknown, field: string, allowed: readonly T[],
): T | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  return oneOf(v, field, allowed);
}

export function coatTags(v: unknown, field: string): string[] | undefined {
  if (v === undefined) return undefined;
  if (v === null) return [];
  if (!Array.isArray(v)) throw new HttpError(400, `${field} must be an array`);
  const out: string[] = [];
  for (const item of v) {
    const tag = oneOf(item, field, COAT_TAGS);
    if (!out.includes(tag)) out.push(tag);
  }
  return out.sort();
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function uuid(v: unknown, field: string): string {
  if (typeof v !== 'string' || !UUID.test(v)) throw new HttpError(400, `${field} must be a UUID`);
  return v.toLowerCase();
}

export function lat(v: unknown): number {
  return num(v, 'lat', -90, 90);
}
export function lon(v: unknown): number {
  return num(v, 'lon', -180, 180);
}

/** A photo taken in the future, or before digital cameras, is bad data rather than an
 *  interesting edge case. Allow a day of clock skew forward. */
export function seenAt(v: unknown, now: number): number {
  return int(v, 'seenAt', 946_684_800_000, now + 86_400_000);
}

export function photoDim(v: unknown, field: string): number {
  return int(v, field, 1, MAX_PHOTO_DIM);
}

export const validators = {
  note: (v: unknown) => optStr(v, 'note', MAX_NOTE_LEN),
  name: (v: unknown) => optStr(v, 'name', MAX_NAME_LEN),
  size: (v: unknown) => optOneOf(v, 'size', SIZE_TAGS),
  petted: (v: unknown) => optOneOf(v, 'petted', PETTED_VALUES),
  locationSource: (v: unknown) => oneOf(v, 'locationSource', LOCATION_SOURCES),
};
