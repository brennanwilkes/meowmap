/* Every tunable, each commented with the measurement or incident that justifies it. */

/** Set after the first Worker deploy. */
export const API_BASE = 'https://meowmap-api.brennan-a53.workers.dev';

/* ── map ───────────────────────────────────────────────────────────────────
 * TILE PROVIDERS BETRAY YOU SILENTLY, so never hard-code one.
 *
 * CARTO's free basemaps now stamp "API KEY REQUIRED" onto the imagery while still
 * returning HTTP 200 with distinct per-tile bytes — a status check does not catch it,
 * only looking at the map does. That happened in vessel-tracker's production and forced
 * an emergency swap. Keeping several keyless providers plus a switcher in Settings makes
 * the next betrayal a one-tap fix rather than a redeploy.
 *
 * All of these are keyless. Verified reachable 2026-09-10.
 */
export const TILE_SOURCES = [
  {
    id: 'osm',
    label: 'Standard',
    url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution: '&copy; OpenStreetMap',
    maxZoom: 19,
  },
  {
    id: 'hot',
    label: 'Warm',
    // MEASURED: the bare host `tile.openstreetmap.fr/hot/...` returns 404. Only the
    // a/b/c subdomains serve, so the {s} placeholder is required, not decorative.
    url: 'https://{s}.tile.openstreetmap.fr/hot/{z}/{x}/{y}.png',
    subdomains: 'abc',
    attribution: '&copy; OpenStreetMap, tiles by HOT',
    maxZoom: 19,
  },
  {
    id: 'esri-street',
    label: 'Detailed',
    // ArcGIS uses {z}/{y}/{x} — the axis order is swapped relative to every other
    // provider here, and getting it wrong yields a plausible-looking map of the wrong
    // place. It also has no {s} shard.
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}',
    attribution: '&copy; Esri',
    maxZoom: 19,
    maxNativeZoom: 18,
  },
];
export const DEFAULT_TILE_ID = 'osm';

/** Victoria BC. Used when geolocation is denied or times out — and the UI says so
 *  rather than silently pretending this is where she is. */
export const FALLBACK_CENTRE = { lat: 48.4284, lon: -123.3656 };
export const DEFAULT_ZOOM = 15;

/* ── geolocation ───────────────────────────────────────────────────────────
 * She is WALKING, so a cached fix from five minutes ago is a block away —
 * maximumAge must stay 0. The first iOS fix is typically a 1–3 km cell estimate with
 * the good GPS fix arriving 3–10 s later, which is why this converges rather than
 * taking the first reading. */
export const GEO_TARGET_ACCURACY_M = 20;
export const GEO_MAX_WAIT_MS = 12_000;
export const GEO_OPTIONS = { enableHighAccuracy: true, timeout: 20_000, maximumAge: 0 };
/** Above this, pre-open the pin-correction step instead of quietly accepting the fix. */
export const GEO_POOR_ACCURACY_M = 100;

/* ── photos ────────────────────────────────────────────────────────────────
 * Budgets are enforced by a bounded quality search, not a fixed quality — a busy
 * cat-in-a-bush and a flat sleeping cat compress very differently. */
export const FULL_LONG_EDGE = 2048;
export const FULL_MAX_BYTES = 550_000;
export const FULL_START_QUALITY = 0.85;
export const FULL_MIN_QUALITY = 0.55;

export const THUMB_LONG_EDGE = 480;
export const THUMB_MAX_BYTES = 45_000;
export const THUMB_START_QUALITY = 0.72;
export const THUMB_MIN_QUALITY = 0.45;

/** At most this many extra encodes during the search. toBlob on a 3 MP canvas is
 *  ~30–60 ms, so 4 is ~250 ms worst case behind an explicit "Processing…" state. */
export const QUALITY_SEARCH_STEPS = 4;

/** iOS silently produces a BLANK canvas above w*h > 16,777,216 — no exception. The
 *  destination is never the problem (2048x1536 = 3.1 MP); the source is: a 24 MP iPhone
 *  still is 98 MB of RGBA and a 48 MP one is 195 MB. Above this ceiling we ask the
 *  decoder to downscale during decode so the full bitmap is never materialised.
 *  CONFIRM against a real 48 MP photo with probe.html. */
export const SOURCE_PIXEL_CEILING = 30_000_000;
export const RESIZE_ON_DECODE_LONG_EDGE = 4000;

/** Read EXIF from a head slice rather than the whole file — 256 KB clears the APP1
 *  segment and any ICC profile, and holding a 12 MB ArrayBuffer next to a decoded
 *  bitmap on a memory-tight iPhone is asking for trouble. */
export const EXIF_HEAD_BYTES = 256 * 1024;

/** Deliberately excludes image/heic: including it makes Safari 17+ transcode JPEGs
 *  INTO HEIC. One constant so it is a one-line flip after device testing. */
export const ACCEPT_TYPES = 'image/jpeg,image/png';

/* ── the same-cat suggester ────────────────────────────────────────────────
 * Thresholds live in app/suggest.js next to the scoring they belong to. */

/* ── offline ───────────────────────────────────────────────────────────────
 * Background Sync has never shipped in any Safari, and the target is iPhone only, so
 * the flush loop lives in the page and there is deliberately no service-worker sync
 * path. Nothing uploads while the app is closed. */
export const FLUSH_BACKOFF_BASE_MS = 30_000;
export const FLUSH_BACKOFF_MAX_MS = 30 * 60_000;
export const FLUSH_MAX_ATTEMPTS = 12;
export const UPLOAD_TIMEOUT_MS = 60_000;
/** How old a pending upload must be before the banner escalates its wording. */
export const OUTBOX_NAG_AFTER_MS = 6 * 3_600_000;

/* ── storage keys ──────────────────────────────────────────────────────────
 * Convention: meowmap:<kebab-key>. */
export const LS = {
  deviceId: 'meowmap:device-id',
  pass: 'meowmap:upload-pass',
  tileSource: 'meowmap:tile-source',
  lastView: 'meowmap:last-view',
  locationNagSeen: 'meowmap:location-nag-seen',
};
