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

/** The default view: James Bay (SW) to Mount Tolmie (NE) — the walkable core of
 *  Victoria. Fitting BOUNDS rather than setting a zoom is what keeps this correct on
 *  every screen: the same zoom level shows wildly different areas on a phone and a
 *  laptop, so a hardcoded number is right on exactly one device. */
export const DEFAULT_BOUNDS = {
  sw: { lat: 48.4130, lon: -123.3790 },
  ne: { lat: 48.4620, lon: -123.3120 },
};

/* ── geolocation ───────────────────────────────────────────────────────────
 * She is WALKING, so a cached fix from five minutes ago is a block away —
 * maximumAge must stay 0. The first iOS fix is typically a 1–3 km cell estimate with
 * the good GPS fix arriving 3–10 s later, which is why this converges rather than
 * taking the first reading. */
// MEASURED on iPhone 18.7.5: the first fix arrives at ~1.2s reporting exactly 20 m and
// then never improves — five readings over 12s were byte-identical. A target of 20 sat
// exactly on the boundary, so a device reporting 21 m would have waited the full 12s for
// nothing. 30 leaves headroom without accepting a genuinely bad fix.
export const GEO_TARGET_ACCURACY_M = 30;
export const GEO_MAX_WAIT_MS = 12_000;
export const GEO_OPTIONS = { enableHighAccuracy: true, timeout: 20_000, maximumAge: 0 };
/** Above this, pre-open the pin-correction step instead of quietly accepting the fix. */
export const GEO_POOR_ACCURACY_M = 100;

/* The map dot is a LIVE watch now, not a one-shot: she walks while the app is open, and
 * a dot that only moves when the next photo uploads is lying about where she is. But
 * fixes arrive roughly once a second and carry 10-20 m of GPS noise, so a dot that
 * redrew for every fix would jitter even standing still — iOS's static fixes happen to
 * be byte-identical right now, which is not a contract to bet against. */
/** Metres a fix must move the dot before it is rewritten. 15 m ≈ the GPS noise floor,
 *  so a walking person crosses it in ~10 s and a standing one never does. */
export const GEO_TRACK_MIN_MOVE_M = 15;
/** The accuracy ring is a "this fuzzy" statement, so a redraw for ±5 m is garbage. */
export const GEO_TRACK_ACCURACY_GAIN_M = 5;

/* ── photos ────────────────────────────────────────────────────────────────
 * Budgets are enforced by a bounded quality search, not a fixed quality — a busy
 * cat-in-a-bush and a flat sleeping cat compress very differently. */
/* The ladder the full-size encode walks down when a photo will not fit the byte budget
 * at its quality floor.
 *
 * MEASURED IN THE FIELD: a normal iPhone photo came out at 645 KB at 2048px / q0.55 and
 * the pipeline REFUSED IT. That is the wrong trade by a mile — a 1664px cat is still a
 * perfectly good cat, and a photo she cannot upload is worth nothing at all. Dropping
 * the long edge cuts pixels quadratically, so one step down is roughly a third fewer
 * bytes, which clears the budget where another quality notch could not.
 *
 * The byte ceiling still holds, which is what keeps the R2 storage projection honest —
 * we give up resolution, never the budget. */
export const FULL_LONG_EDGE = 2048;
export const FULL_EDGE_LADDER = [2048, 1664, 1280];
export const FULL_MAX_BYTES = 550_000;
export const FULL_START_QUALITY = 0.85;
export const FULL_MIN_QUALITY = 0.55;

export const THUMB_LONG_EDGE = 480;
/** Same escape hatch as the full image: a thumbnail that will not fit is still better
 *  small than absent, and the map only ever draws it at 46px anyway. */
export const THUMB_EDGE_LADDER = [480, 384, 320];
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
 *  MEASURED: this phone shoots 12.2 MP (4032x3024), comfortably under the ceiling, so
 *  the guard will not normally fire. When it does, resize-on-decode IS honoured here —
 *  512 requested, 512 delivered. Still unverified against an actual 48 MP source. */
export const SOURCE_PIXEL_CEILING = 30_000_000;
export const RESIZE_ON_DECODE_LONG_EDGE = 4000;

/** Read EXIF from a head slice rather than the whole file — 256 KB clears the APP1
 *  segment and any ICC profile, and holding a 12 MB ArrayBuffer next to a decoded
 *  bitmap on a memory-tight iPhone is asking for trouble. */
export const EXIF_HEAD_BYTES = 256 * 1024;

/** Deliberately excludes image/heic: including it makes Safari 17+ transcode JPEGs
 *  INTO HEIC. One constant so it is a one-line flip after device testing. */
export const ACCEPT_TYPES = 'image/jpeg,image/png';

/* ── tag vocabularies ──────────────────────────────────────────────────────
 * THESE MUST MATCH `worker/src/constants.ts` EXACTLY — the Worker rejects anything it
 * does not recognise, so a drifted chip here is a 400 at save time. There is no bundler
 * to share the declaration across the TS Worker and the buildless frontend, so
 * `tests/vocab.test.mjs` reads both and asserts they agree. */
export const COAT_TAGS = ['orange', 'black', 'white', 'grey', 'tabby', 'tuxedo', 'calico'];
export const SIZE_TAGS = ['kitten', 'adult', 'chonk'];
export const PETTED_VALUES = ['yes', 'no'];
export const MAX_NOTE_LEN = 280;
export const MAX_NAME_LEN = 60;

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
/* Fired on `window` when the tile provider is switched in Settings.
 *
 * The map tab STAYS MOUNTED underneath the Settings sheet — that is deliberate, so
 * closing a detail never re-runs a map build — which means the map never re-reads the
 * preference and the switch appeared to do nothing until a full reload. An event rather
 * than settings_page importing map_page: pages here do not import each other. */
export const TILE_CHANGED = 'meowmap:tile-changed';

export const LS = {
  deviceId: 'meowmap:device-id',
  pass: 'meowmap:upload-pass',
  tileSource: 'meowmap:tile-source',
  lastView: 'meowmap:last-view',
  installHintSeen: 'meowmap:install-hint-seen',
};

/* `meowmap:location-nag-seen` was reserved for the "turn on Options -> Location in the
 * picker" card and is deliberately NOT here. The probe falsified its premise: a library
 * photo arrived with full GPS, untouched settings. A photo with no GPS is now a
 * screenshot or a shared image, for which that instruction is not the fix. */

/* ── measured iOS behaviour (probe.html, iPhone iOS 18.7.5 Safari, 2026-09-11) ──
 *
 * DO NOT pass `imageOrientation` to createImageBitmap. The option is IGNORED on this
 * device (honoursOrientationOption: false), while the default already auto-applies EXIF
 * orientation (a 4032x3024 photo tagged orientation 6 decodes as 3024x4032). Passing it
 * is a harmless no-op today, but writing code that depends on it would be a bug — and
 * manually rotating on top of the automatic rotation produces sideways cats.
 *
 * `canvas.toBlob('image/webp')` returned **image/png** on this device — the documented
 * silent fallback, confirmed. A 2048px PNG is ~5 MB, so if WebP is ever added it MUST
 * assert blob.type and throw. This is why the pipeline is JPEG-only. */
export const PASS_IMAGE_ORIENTATION = false;
export const ASSERT_ENCODED_MIME = true;
