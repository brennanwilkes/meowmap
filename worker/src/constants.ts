export const JSON_CT = 'application/json; charset=utf-8';
export const JPEG_CT = 'image/jpeg';

/* ── R2 cost breaker ─────────────────────────────────────────────────────────
 * Everything else in the stack fails closed by itself: Workers requests 1027, D1
 * hard-fails until midnight UTC, Turnstile is unlimited. R2 keeps serving and BILLS,
 * and Cloudflare offers no native spend cap on it, so these numbers are the control.
 *
 * Free tier: 10 GB storage, 1M class A ops/mo, 10M class B ops/mo.
 * Overage:   $0.015/GB, $4.50/M class A, $0.36/M class B.
 * ─────────────────────────────────────────────────────────────────────────── */

/** 8 GB of 10. Trip well before the cliff — storage accretes and nobody is watching. */
export const R2_BYTE_CEILING = 8_000_000_000;

/** 7M of 10M class B per month. The only genuinely unbounded exposure, because photos
 *  must be publicly readable and so cannot sit behind the upload pass. */
export const R2_READ_CEILING = 7_000_000;

/** ~15x a heavy real day. She will never see this; an attacker with a valid pass will. */
export const UPLOADS_PER_DAY = 300;

/** Reject before reading the body. The client targets ~550 KB for the full derivative. */
export const MAX_PHOTO_BYTES = 4_000_000;

/** Count 1 read in N and multiply. An exact counter would cost a D1 write per photo
 *  view, i.e. blowing the D1 budget to protect the R2 one. Drift is corrected monthly
 *  by scripts/r2-reconcile.mjs. */
export const READ_SAMPLE_RATE = 100;

/* ── auth ──────────────────────────────────────────────────────────────────── */
export const PASS_TYP = 'upload_pass';
export const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
export const TURNSTILE_ACTION = 'upload';
/** Defence in depth against a leaked sitekey used from someone else's page: siteverify
 *  reports the hostname the challenge was solved on, and we pin it.
 *
 *  NOTE this is a GitHub Pages *project* deploy, so the app lives at a path
 *  (brennanwilkes.github.io/meowmap/) on a hostname shared with every other repo of
 *  Brennan's that publishes to Pages. Turnstile matches hostname only, so this widget
 *  is valid from any of them — acceptable for a personal account, and narrowed further
 *  by also pinning TURNSTILE_ACTION. Add the custom domain here when it exists rather
 *  than replacing this entry; the widget allows 10 hostnames.
 *
 *  localhost and 127.0.0.1 are added automatically by Cloudflare so the widget renders
 *  in development. */
export const TURNSTILE_HOSTNAMES = [
  'localhost',
  '127.0.0.1',
  'brennanwilkes.github.io',
];

/* ── caching ───────────────────────────────────────────────────────────────── */
/** Safe only because keys are content-addressed: the bytes at a given key can never
 *  change, so `immutable` is not a lie. This is also the single biggest cost saving —
 *  a returning phone re-renders the whole map with zero photo requests. */
export const PHOTO_CACHE_CONTROL = 'public, max-age=31536000, immutable';
export const BULK_CACHE_CONTROL = 'public, max-age=0, s-maxage=300, must-revalidate';
export const CONFIG_CACHE_CONTROL = 'public, max-age=300, s-maxage=86400';
export const NO_STORE = 'no-store';

/* ── validation ────────────────────────────────────────────────────────────── */
export const COAT_TAGS = ['orange', 'black', 'white', 'grey', 'tabby', 'tuxedo', 'calico'] as const;
export const SIZE_TAGS = ['kitten', 'adult', 'chonk'] as const;
export const PETTED_VALUES = ['yes', 'no'] as const;
export const LOCATION_SOURCES = ['exif', 'device', 'manual'] as const;
export const MAX_NOTE_LEN = 280;
export const MAX_NAME_LEN = 60;
export const MAX_UA_LEN = 256;

/** Client-supplied derivative dimensions we are willing to believe. */
export const MAX_PHOTO_DIM = 8000;

/* ── photo derivatives (advertised to the client via GET /config) ──────────── */
export const FULL_LONG_EDGE = 2048;
export const THUMB_LONG_EDGE = 480;
export const FULL_MAX_BYTES = 550_000;
export const THUMB_MAX_BYTES = 45_000;
