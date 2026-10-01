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
/* NO s-maxage. It was 300, and that is why a freshly uploaded cat did not appear on the
 * map for up to five minutes: the edge served its cached copy without ever asking the
 * Worker, so the ETag revalidation that makes this endpoint cheap never ran.
 *
 * Losing the edge cache costs almost nothing here. A warm client sends If-None-Match and
 * the Worker answers 304 after reading ONE row (app_meta.data_version), so even several
 * hundred app opens a day is a rounding error against the 5M/day read limit. Edge
 * caching only starts to matter with a wide, globally distributed audience — and if that
 * ever happens, the fix is the R2 snapshot in the plan, not a staleness window that
 * makes the app look broken for the two people who actually use it.
 *
 * The photos keep their immutable year-long cache, which is where the real saving is. */
export const BULK_CACHE_CONTROL = 'public, max-age=0, must-revalidate';
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

/* ── push notifications ────────────────────────────────────────────────────── */
/** VAPID public key: public by design, it is how a phone knows a push came from us.
 *  Declared in frontend/config.js as well; tests/vocab.test.mjs asserts they agree. The
 *  private half is the VAPID_PRIVATE_KEY secret, pushed by CI. Rotating the pair silently
 *  orphans every subscription, so each phone has to turn notifications on again. */
export const VAPID_PUBLIC_KEY = 'BPYSsg5Wa5HLSV9h2Cv8nqt7JAiGi1SG8BcsUvNMZlgVpEtGDw7EiKudpLanLvUEKwpwEsn12Ee5uUj-8ixVzfA';
/** The contact Apple and Google see on every push. The app's own URL rather than an
 *  email address, so no personal address is sent to a third party. */
export const VAPID_SUBJECT = 'https://brennanwilkes.github.io/meowmap/';
/** Push services we will POST to. The Worker fetches whatever endpoint a phone hands it,
 *  so without this a subscription could aim it at any URL on the internet. */
export const PUSH_HOSTS = ['web.push.apple.com', 'fcm.googleapis.com', 'updates.push.services.mozilla.com'];
export const PUSH_HOST_SUFFIXES = ['.push.apple.com', '.notify.windows.com'];
/** Every upload sends one request per subscription, and the free plan allows 50
 *  subrequests per invocation. Two people need two; this caps what a stranger who opts
 *  in can add. */
export const MAX_PUSH_SUBSCRIPTIONS = 10;
/** How long a push service holds a notification for a phone that is off. A day-old "a
 *  cat was spotted" is still worth seeing; a week-old one is noise. */
export const PUSH_TTL_S = 86_400;

/** Who a device belongs to, by the upload pass's device UUID (shown at the bottom of
 *  Settings). Two jobs: naming the sender ("Isabelle spotted Baby"), and not notifying
 *  a person about their own photo from another of their devices. A device missing from
 *  here still works: its uploads just say "Someone", and only that one device is skipped.
 *  Read from sightings.device_id on 2026-10-01. A device's id changes if its storage is cleared or
 *  the app is reinstalled. */
export const DEVICE_OWNERS: Record<string, string> = {
  'dbbe5d7b-f598-49a8-845d-14a1e08801d8': 'Isabelle',
  '94022a6a-fb8c-4a30-a04b-0ae077973087': 'Brennan',
  '150169f0-affb-48b8-992a-fcd39b65858a': 'Brennan',
  '663ce59c-7ce6-4301-9642-4582da9b0de5': 'Brennan',
};
