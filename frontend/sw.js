/* Meowmap service worker. Classic script, self-contained, no imports.
 *
 * GITHUB PAGES SUBPATH IS THE #1 PWA KILLER. The site serves at
 * brennanwilkes.github.io/meowmap/, so scope is capped at /meowmap/ and EVERY path below
 * must be relative. A single leading slash here silently precaches nothing and the app
 * appears to install but never works offline.
 *
 * Buildless means no content hashing, so BUILD is hand-written. Bump it on every
 * frontend change or the shell cache never rotates.
 */

const BUILD = '2026-09-14c';

const SHELL = `shell-${BUILD}`;
const API = 'api-v1';
const PHOTOS = 'photos-v1';
const TILES = 'tiles-v1';
const MINE = new Set([SHELL, API, PHOTOS, TILES]);

/* Thumbnails are ~40 KB, so 1500 is roughly 60 MB. cache.keys() returns INSERTION
 * order, which makes FIFO eviction free — no LRU bookkeeping table needed. */
const PHOTO_CAP = 1500;
const TILE_CAP = 400;

const FILES = [
  './',
  './index.html',
  './offline.html',
  './manifest.webmanifest',
  './config.js',
  './styles/tokens.css',
  './styles/base.css',
  './styles/layout.css',
  './styles/sticker.css',
  './styles/map.css',
  './styles/sheet.css',
  './styles/capture.css',
  './app/api.js',
  './app/capture_page.js',
  './app/cat_page.js',
  './app/catcolor.js',
  './app/cats_page.js',
  './app/components/chips.js',
  './app/decode.js',
  './app/device.js',
  './app/dom.js',
  './app/exif.js',
  './app/filter.js',
  './app/flush.js',
  './app/geolocate.js',
  './app/idb.js',
  './app/main.js',
  './app/map_page.js',
  './app/nav.js',
  './app/outbox.js',
  './app/pipeline.js',
  './app/pwa.js',
  './app/resize.js',
  './app/settings_page.js',
  './app/sheet.js',
  './app/sighting_page.js',
  './app/store.js',
  './app/suggest.js',
  './app/turf.js',
  './app/turnstile.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon-180.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const cache = await caches.open(SHELL);
    // `cache: 'reload'` bypasses the HTTP cache, which matters because GitHub Pages puts
    // a ~10 minute CDN TTL on index.html — without it a fresh install can precache the
    // previous deploy's shell.
    await cache.addAll(FILES.map((u) => new Request(u, { cache: 'reload' })));
  })());
  // Deliberately NO skipWaiting() here. Swapping ES module versions under a running page
  // yields half-old-half-new state. The page asks for the swap; see the message handler.
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const name of await caches.keys()) {
      if (!MINE.has(name)) await caches.delete(name);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('message', (e) => {
  if (e.data === 'SKIP_WAITING') self.skipWaiting();
});

async function trim(cacheName, cap) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - cap; i++) await cache.delete(keys[i]);
}

/** Cache-first, and never cache a non-200 — a cached 404 is indistinguishable from a
 *  real one for as long as it lives. */
async function cacheFirst(req, cacheName, cap) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req);
  if (hit !== undefined) return hit;

  const res = await fetch(req);
  if (res.status === 200 && res.type !== 'opaque') {
    await cache.put(req, res.clone());
    if (cap !== null) trim(cacheName, cap);
  }
  return res;
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // A navigation must never 404 into the browser's offline page: the app is a hash
  // router, so every route is index.html.
  if (req.mode === 'navigate') {
    e.respondWith((async () => {
      const cache = await caches.open(SHELL);
      try {
        const fresh = await fetch(req);
        if (fresh.status === 200) return fresh;
      } catch { /* offline — fall through */ }
      return (await cache.match('./index.html'))
        ?? (await cache.match('./offline.html'))
        ?? Response.error();
    })());
    return;
  }

  // Photos are content-addressed and served immutable, so the URL can never go stale.
  if (url.pathname.startsWith('/photo/')) {
    e.respondWith(cacheFirst(req, PHOTOS, PHOTO_CAP));
    return;
  }

  if (/\.(png|jpg|jpeg)$/.test(url.pathname)
      && (url.hostname.includes('tile.') || url.hostname.includes('arcgisonline'))) {
    e.respondWith(cacheFirst(req, TILES, TILE_CAP));
    return;
  }

  /* The bulk sightings fetch: NETWORK FIRST, cache only as an offline fallback.
   *
   * This was stale-while-revalidate and it was wrong. The store already does its own
   * conditional GET with an ETag, so SWR put a second, conflicting cache in front of it:
   * the page got last launch's rows, believed them current because they arrived as a
   * 200, and the revalidation landed after the render. The visible symptom was a map
   * that did not show a cat you had just uploaded until a hard reload.
   *
   * One cache for this data, and the store owns it. A 304 is passed straight through —
   * it has no body, and the store keeps what it has. */
  if (url.pathname === '/sightings') {
    e.respondWith((async () => {
      const cache = await caches.open(API);
      try {
        const res = await fetch(req);
        if (res.status === 200) cache.put(req, res.clone());
        return res;
      } catch {
        // Offline. A cached copy is much better than a blank map; if there is none,
        // let the store surface the failure rather than inventing an empty result.
        const hit = await cache.match(req);
        if (hit !== undefined) return hit;
        throw new Error('offline and nothing cached');
      }
    })());
    return;
  }

  if (url.origin === self.location.origin) {
    e.respondWith(cacheFirst(req, SHELL, null));
  }
});
