# Meowmap — Project Memory

## What this is

A public, login-free, phone-first web app for recording cats seen in public. Photo in,
pinned on a map, optionally grouped into named cats so repeat sightings show as one
animal's territory. Victoria BC by default, works anywhere the map is moved.

Built for one person's daily use (Brennan's wife), **iPhone only**, **strictly free tier**.

```
frontend/   GitHub Pages, buildless ES modules, no framework
worker/     Cloudflare Worker (TypeScript) — API + R2 photo serving
mockups/    Design reference. scrapbook-tactile.html is the source of truth for feel.
tests/      Plain .mjs run with bare `node`, importing real app modules
```

## Cloudflare account — ONLY this one

| | |
|---|---|
| Email | `brennan@codexwilkes.com` |
| Account ID | `a53d0d3cb40662b52e001ffd082d2f1f` |

`brennan@textgroove.com` (work) is also authed on this machine. **Never change Cloudflare
auth.** If `wrangler whoami` shows anything else, or a command returns
`Authentication error [code: 10000]`, stop and ask Brennan to re-auth. Do not run
`wrangler login`/`logout`, do not switch accounts, do not edit `~/.wrangler/config/default.toml`.
Wrong-account writes land in someone else's production.

## Cost safety — the one rule that outranks features

**Break functionality before spending money.**

Everything in the stack fails closed on its own *except R2*:

| Service | Over free limit | Bills? |
|---|---|---|
| Workers requests | requests fail (1027) | No |
| D1 rows read/written | queries fail till midnight UTC (enforced 2026-09-01) | No |
| Turnstile | unlimited free | No |
| **R2** | **keeps serving and bills** | **YES** |

Cloudflare has **no native spend cap on R2**, so the in-app breaker is the only control.
Ceilings live in `worker/src/constants.ts`; usage lives in `app_meta`; `GET /health`
reports both. Over ceiling, uploads return `507` and photo reads return `503` — and the
client must **keep the photo in the outbox, never discard it**. Failing closed must not
also lose her photo.

Class B (reads) is the only genuinely unbounded exposure, since photos must be public.
Reads are counted by 1-in-100 sampling — an exact counter would cost a D1 write per photo
view and blow the D1 budget to protect the R2 one.

## Conventions

- **No bundler, no framework, no npm deps in the frontend.** Raw ES modules with explicit
  `.js` extensions; CDN `<script>` for Leaflet. Deploy = upload the directory.
- **Zero runtime deps in the Worker.** `index.ts` is routes only; `http.ts` is the only
  place a `Response` is constructed; `storage.ts` is the only place D1 or R2 is touched.
- Page modules export `mount(container)` / `unmount()`. `unmount()` must release every
  subscription, listener, object URL and the Leaflet instance.
- Stores expose `subscribe(fn)` that fires immediately *and* on change, returning an
  unsubscribe.
- All tunables in one `config.js` (frontend) / `constants.ts` (worker), each commented with
  the measurement that justifies it.
- `esc()` on every interpolated string — everything renders via `innerHTML` templates.
- **No silent fallbacks** (`?? 0`). Throw and surface bad data.
- **IDs can be `0`.** Always `!== null`, never a falsy check.
- Comments explain non-obvious *why*, never *what*.
- Helpers only at >=2 uses (big) or >=4 (small); otherwise inline.
- Per-device prefs in `localStorage` under `meowmap:<kebab-key>`.
- View/template files: all logic at the top, pure rendering at the bottom.

## D1

- Timestamps are **INTEGER epoch-ms**, never TEXT.
- **`INTEGER PRIMARY KEY`, never `AUTOINCREMENT`** — `AUTOINCREMENT` adds a
  `sqlite_sequence` UPDATE, i.e. a second row *written*, to every insert.
- **Soft delete** (`deleted_at`). Rowids are recycled after a `DELETE`, and a recycled id
  would silently re-point every offline client's cached record at a different cat.
- **Every secondary index entry is a row written** against the 100k/day cap. An index that
  doesn't earn its keep on reads is a permanent tax. `001_initial.sql` carries an omission
  log naming the indexes deliberately *not* created and why — keep it current.
- Migrations are `worker/migrations/NNN_snake_case.sql`, applied in CI by
  `scripts/ensure-bindings.mjs`. Drop a new numbered file in and push.

## Design

Direction settled after five mockups. Tokens in `frontend/styles/tokens.css`; that file's
header states the two rules that erode silently. In short:

- **Nothing is half-rounded.** 2px or a true circle. 12–20px reads as "badge", which was
  rejected repeatedly.
- **A sticker = die-cut paper margin + hard offset shadow + slight hand-stuck tilt.**
- **The press is physically motivated:** a sticker sits `2px 3px` off the page, so pressing
  translates by exactly that and collapses the shadow. Not a generic scale-down.
- Unselected chips lie flat on the page; selected ones are stuck on.
- Page turns are sheets sliding across a desk; detail views slide *up*, so hierarchy and
  lateral movement never look the same.
- **iPhone only means no haptics exist** — the entire tactile impression is motion, which
  makes the timing tokens load-bearing rather than cosmetic.
- Bottom nav is still unresolved; four forms tried. A continuous full-width bar reads as
  chrome and fights the conceit, so the fix is the form, not the finish.

## Map

- Leaflet from CDN, `preferCanvas: true`. Render load is bounded by **layer count**, not
  point count.
- **No `L.popup` / `L.tooltip`** anywhere — a custom bottom sheet, sibling to the map div.
- Tint `.leaflet-tile-pane`, never the marker pane.
- **Tile providers betray you silently.** CARTO's free basemaps now stamp "API KEY REQUIRED"
  onto the imagery while still returning HTTP 200 with distinct per-tile bytes, so a status
  check does not catch it. Hence `TILE_SOURCES` (several keyless providers) plus a switcher
  in Settings, so a betrayal is a one-tap fix rather than a redeploy.
- **OSM Humanitarian only serves from the `a.`/`b.`/`c.` subdomains** — bare
  `tile.openstreetmap.fr/hot/{z}/{x}/{y}.png` returns 404. Get the `{s}` shard right.
- **Territory blobs:** 3+ sightings earns a "<name>'s turf" zone; 2 gets a dashed line.
  Connector lines past 4–5 points turn to spaghetti. The blob is the support function of
  the points at 44 angles, padded ~70 m, with a deterministic sine wobble.
- The turf label needs **its own pane** (`createPane('turf')`, zIndex 650). Both labels and
  pins are markers and `markerPane` sorts by latitude, so a `zIndexOffset` fight works by
  accident and breaks when a pin drifts north of the label.
- Turf labels hide below zoom 16 and are tappable.
- **The coat filter (`filter.js`) is OR, transient, and filters territory too.** OR is
  monotone, so an extra chip can only reveal more. It is deliberately not persisted — a
  filter surviving a relaunch looks like lost data. Filtering pins without also
  filtering `catsWithSightings` draws a turf blob around points that are not there.

## iOS realities that shaped the build

**MEASURED on the actual device** via `frontend/probe.html`, iPhone iOS 18.7.5 Safari,
2026-09-11. Two of these contradict what the documentation said, so trust this table over
any blog post — and re-run the probe after an iOS major version.

| Behaviour | Measured |
|---|---|
| Library photo GPS | **PRESENT** — `48.42985833, -123.36201389`, accuracy 9.98 m, with no picker setting changed. The documented "stripped by default" did NOT reproduce |
| Library photo timestamps | `DateTimeOriginal` + `OffsetTimeOriginal` + `GPSDateStamp/TimeStamp` all present |
| `capture=` EXIF | **Partially stripped**: `orientation` survives, but date and GPS are `null`. Not "all EXIF" as documented |
| Orientation auto-applied | **Yes** — a 4032x3024 photo tagged orientation 6 decodes as 3024x4032 |
| `imageOrientation` option | **IGNORED** (`honoursOrientationOption: false`). Do not pass it and do not depend on it |
| `createImageBitmap` `resizeWidth` | **Honoured** — 512 requested, 512 delivered |
| `toBlob('image/webp')` | **Returned `image/png`** — the silent fallback, confirmed. JPEG only |
| Background Sync | Absent, as expected |
| `navigator.vibrate` | Absent — no haptics, confirmed |
| `storage.persist()` | **DENIED** in Safari (`standalone: false`). Untested as an installed home-screen app, which is where WebKit's heuristic is supposed to favour granting |
| Storage quota | 41 GB. Quota is not the constraint; **eviction** is |
| Geolocation | First fix at 1.2 s reporting 20 m, then five identical readings over 12 s — it never improves. Target loosened to 30 m so we resolve immediately instead of sitting on the boundary |
| Camera | 12.2 MP (4032x3024), ~3.9 MB. Well under `SOURCE_PIXEL_CEILING` |
| Cross-validation | The EXIF parser's coordinates matched `navigator.geolocation` to 5 decimal places, on a real photo |

The EXIF GPS was *more* accurate than the live browser fix (9.98 m vs 20 m), which is a
good reason to keep preferring it when present.

Still unverified: an actual 48 MP source, HEIC via Format=Current, and whether the
picker's Location toggle is sticky (it did not need touching here).

## Photo pipeline

- **Order is fixed:** `file.slice(0, 256KB)` → `readImageMeta` → `decode` → `resize`.
  `canvas.toBlob()` emits a bare JFIF JPEG with no APP1 segment, so every re-encode
  destroys all metadata unconditionally. EXIF must be read from the original bytes first.
- **Never pass `imageOrientation` and never rotate manually.** Measured: the option is
  ignored, and orientation is auto-applied. Doing both gives sideways cats.
- **JPEG only**, and `ASSERT_ENCODED_MIME` turns the silent PNG substitution into a throw.
- Byte budgets are hit by **bounded bisection**, not a fixed quality — a cat in a bush and
  a cat asleep on a step compress an order of magnitude apart. Over budget at
  `minQuality` throws; a 3 MB "thumbnail" is worse than a failure.
- The thumb is drawn **from the full canvas**, so it is a pixel-consistent reduction of
  the image that actually ships.
- **Location resolution has no nag card.** The probe falsified its premise. Missing GPS
  now means a screenshot or a shared image, so it goes straight to tap-the-map. An old
  photo never borrows the current fix; a fresh one (<10 min) may, and says so.
- `input.value = ''` before every `.click()`, and the `.click()` must be **synchronous
  inside the user gesture** — start geolocation after it, never await before it.

## Two-file vocabularies

`COAT_TAGS`, `SIZE_TAGS`, `PETTED_VALUES` and the length caps are declared in **both**
`frontend/config.js` and `worker/src/constants.ts`; there is no bundler to share one
declaration across a buildless ES module and a TS Worker. `tests/vocab.test.mjs` reads
both files and asserts they agree, so drift is a red test rather than a 400 at save time.

## Service worker

- **Every precache path must be relative.** GitHub Pages serves at `/meowmap/`, so a
  leading slash silently precaches nothing and the app appears to install but never works
  offline.
- Buildless means no content hashing: `BUILD` in `sw.js` is hand-written. **Bump it on
  every frontend change** or the shell cache never rotates.
- Precache with `cache: 'reload'` — GH Pages puts a ~10 min CDN TTL on `index.html`.
- **No automatic `skipWaiting()`.** Swapping ES module versions under a running page gives
  half-old-half-new state; the update bar asks first.
- `cache.keys()` returns insertion order, so the photo cap is free FIFO — no LRU table.
- Every `<img>` at the Worker needs `crossorigin="anonymous"`, or the SW sees an opaque
  response whose padded quota accounting blows through storage.

## Routing

Three tabs (`#/map`, `#/snap`, `#/cats`) plus a **detail layer** (`#/cat/<id>`,
`#/sighting/<id>`, `#/settings`) that slides UP over whichever tab is showing. The tab
underneath stays mounted, so closing a detail never re-runs a map build. `go(next,
keepHash)` exists for one reason: a cold load straight onto a detail URL must mount the
tab beneath *without* writing the hash, or it navigates away before the detail opens.

`nav.js` holds `back()`/`navigate()` so pages do not import the router that imports them.

## Editing

- **The sheet is a glance; `#/sighting/<id>` is the only editor.** Two editors that must
  agree is a bug factory.
- **Edits accumulate locally and save on a button**, never per tap: every PATCH is a D1
  write plus an `app_meta` bump against a hard 100k/day cap. The body carries only the
  fields that actually changed.
- **Re-render is suppressed while an input has focus or an edit is unsaved** — the store
  fires on every refresh, including the one a save triggers.
- **Destructive actions arm on the first tap and fire on the second.** No `confirm()`:
  a native dialog in a standalone app looks like the browser breaking through.
- **Multi-step mutations are not atomic and must fail visibly**, not roll back. Grouping
  is `POST /cats` + N PATCHes; ungrouping unlinks *before* deleting the cat, so a
  part-way failure leaves loose sightings rather than dangling references.
- **`accuracyM` must be a whole number.** The Worker validates it with `int()`, both real
  sources are floats (EXIF 9.98, `coords.accuracy` a double), and the outbox treats a 400
  as terminal — so an unrounded value fails every upload permanently. Rounded once in
  `resolveLocation`; guarded by a test.

## Gotchas in this environment

- **Headless Firefox screenshots hang here**, even on a trivial page — spirit-tracker's
  documented `--screenshot` trick is unavailable. Verify markup structurally instead (JS
  parses, tags balance, external URLs 200) and get Brennan to look at anything visual.

## Scripts

`npm run reconcile` recomputes true R2 bytes/objects from the bucket and corrects
`app_meta` (the counters are incremental and `r2_reads_est` is 1-in-100 sampled, so they
drift). `npm run gc` is the same script with `--gc`, which additionally deletes
unreferenced objects. **There is no separate `r2-gc.mjs` and there should not be** — the
reachability union lives in one place or the two copies drift. Both default to a dry run.

Reachability includes soft-deleted rows: tombstones pin their bytes so undelete is free.
The script reports `referenced − listed` (a row whose photo is gone) but never auto-fixes
it — that needs a human.

## Reference

- Plan: `~/.claude/plans/take-a-look-through-imperative-hejlsberg.md` — full build order,
  route table, schema rationale, free-tier budget.
- Sibling projects worth copying from: `~/vessel-tracker` (worker layout, `ensure-bindings.mjs`,
  `db-*` scripts, Leaflet patterns), `~/spirit-tracker-api` (`jwt.ts`, `base64url.ts`),
  `~/spirit-tracker/viz` (mobile CSS discipline, `dom.js`).
