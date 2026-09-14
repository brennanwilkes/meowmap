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
- **An icon drawn as lines radiating from a centre circle is a SUN, not a gear.** The cog
  went through four versions (emoji, square sticker, round stamp, spokes) before landing:
  a gear reads only when the tooth stubs sit on the outside of a closed rim and the hub is
  a hole. The teeth are generated geometry, not hand-guessed points.
- **The cog is `align-self: center` while the topbar aligns on the baseline.** It is a
  replaced element with no text, so its flex baseline is its bottom margin edge and
  baseline-aligning hangs it below the wordmark. The topbar padding is symmetric so that
  centring lands level with it.
- **The wordmark is "MeowMap"**, capital M twice, everywhere user-visible.
- **iPhone only means no haptics exist** — the entire tactile impression is motion, which
  makes the timing tokens load-bearing rather than cosmetic.
- Bottom nav is still unresolved; four forms tried. A continuous full-width bar reads as
  chrome and fights the conceit, so the fix is the form, not the finish.

## Map

- Leaflet from CDN, `preferCanvas: true`. Render load is bounded by **layer count**, not
  point count.
- **No `L.popup` / `L.tooltip`** anywhere — a custom bottom sheet, sibling to the map div.
- Tint `.leaflet-tile-pane`, never the marker pane.
- **There is no attribution on the map at all**, and `.leaflet-control-attribution` is
  `display: none` so a map that forgets `attributionControl: false` cannot put it back.
  It was first moved behind an (i) button; Brennan judged that still clutter and asked
  for it gone, which is his call to make for a private two-person app. Recorded as a
  DELIBERATE DECISION rather than an oversight: OSM's ODbL does ask for credit, so if
  MeowMap is ever made public, the credits go back.
- **No recentre button.** The blue "you are here" dot stays and is dropped once on mount
  without moving the view; `locateMe()` takes no argument and has one caller.
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
- **The map filter (`filter.js`) covers coat, size and petted: OR within a group, AND
  across groups.** Within-group OR keeps each chip monotone (it can only reveal more);
  across-group AND is the only thing that makes a second group worth having. It is
  deliberately not persisted — a filter surviving a relaunch looks like lost data — and
  it filters `catsWithSightings` as well as pins, or a turf blob gets drawn around
  points that are not on the map.

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

## Caching — the two layers that fought each other

A freshly uploaded cat did not appear for up to five minutes, and photos only rendered
after a hard reload. Two separate caches, same symptom:

- **`BULK_CACHE_CONTROL` had `s-maxage=300`.** The Cloudflare edge served `/sightings`
  from its own copy without invoking the Worker, so the ETag revalidation never ran.
  Removed. A warm client's conditional GET costs ONE row read (`app_meta.data_version`),
  so edge caching bought almost nothing for two users and cost the app looking broken.
  It also means an admin script's writes show up immediately instead of 5 minutes later.
- **The service worker did stale-while-revalidate on `/sightings`.** The store already
  does conditional GETs, so SWR was a second, conflicting cache: the page rendered last
  launch's rows, believed them current because they arrived as a 200, and the
  revalidation landed after the render. Now network-first with a cache fallback for
  offline only.

**One cache per piece of data, and the store owns the sightings list.** Photos keep their
immutable year-long cache — content-addressed, so they can never go stale, and that is
where the actual saving is.

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

## Cat identity — there is no wrong way to do it

**Every sighting belongs to a cat from the moment it uploads.** The Worker mints an
unnamed cat when the client sends no `catId`. The original model left `cat_id` NULL until
she linked photos, and "not identified yet" was meant to be a comfortable resting state —
on the phone it was not. A fresh upload had no colour, no territory and no page, and the
only way to give it one was to open the Cats tab and declare a photo the same cat as
itself. Cost: one extra row written per upload (4 → 5 against the 100k/day cap).

Linking is therefore **merging two cats**, and it is phrased as a question in her words:

- `I've seen this cat before` → faces of every other cat, nearest first → **one tap merges**.
- `different cat` under a photo → that photo leaves and becomes its own cat.

These are exact inverses, so every join is reversible by a single tap and nothing can be
left half-done. **The older cat always survives a merge**, whichever way round she taps,
so the one she met first keeps its name and colour.

**NO SELECTION MODES ANYWHERE.** A multi-select merge was built and cut: one tap opened a
cat and the next tap selected it, which is a mode you can be in without noticing. Design
rule for this app — the user is not a power user and must never be able to mess it up:
one tap, on a face, answering a question. No sequences, no confirmations for reversible
things, no "right way".

## Coat, size and petted belong to the CAT

Migration 003 moved all three off `sightings` and onto `cats`, and DROPPED the sighting
columns — two places to write one fact is the bug factory this codebase refuses
everywhere else.

The old shape let one cat be an orange tabby in June and a grey chonk in July, with
nothing in the UI to reconcile them. `petted` moved too: it is arguably per-encounter, and
that was raised and decided — it reads as "have I ever managed to pet this one".

- **Snap still asks**, and the tags seed the cat the Worker mints. Send a `catId` instead
  and they are IGNORED: that cat already has answers, and letting a capture form
  overwrite them rewrites history from a screen that never showed her the old values.
- **Merging unions the coat**; size and petted take the more recently seen cat's answer,
  falling back to the older only where the newer has none. A union loses nothing; size
  cannot union because a cat is not both a kitten and a chonk.
- **Splitting inherits the description it leaves.** She grouped them because they looked
  alike, so an orange tabby splitting off is still an orange tabby.
- **Filtering is now a question about CATS**, so a cat is in or out whole. That deleted
  the old bug where a turf blob was drawn around points that were themselves filtered out.
  `tagsFor()` reads the cat, EXCEPT for a pending upload, which has no cat until the
  Worker mints one and so carries the tags she typed.
- The cat page saves name and tags on ONE debounce, and `unmount()` FLUSHES it rather
  than clearing it — swiping the sheet away within 900 ms used to bin the edit silently.

## The name field

**The capture form's name box names the CAT, and rides along with the sighting insert as
`catName`.** It was collected into the draft and then never sent — she typed "Baby", the
Worker minted the usual unnamed cat, and the app showed "Unnamed". The name reaches the
Worker on `POST /sightings` and is passed to the `insertCat` that was already happening
for every upload, so it costs NO extra row. It is ignored when `catId` is set, or linking
a photo to an existing cat from the capture form would silently rename that cat.

`outbox.newRow` spreads the whole draft, so the name survives an offline queue for free —
only the request body needed the field.

## Migrations

**`migrate.mjs` hands the FILE to wrangler (`--file`); it does not split on `;`.** You
cannot split SQL with a regex, and this schema proves it: 001 contains "null when
unnamed; see the unique index below" and "read with a bare SELECT; an index would be…" in
TRAILING comments, each of which splits mid-sentence and sends English to D1 as a
statement. Stripping whole-line comments first is not enough — that was the first fix and
it left every inline `-- …` still able to do it. CI has always used `--file`; both paths
now parse identically, which is the point of them sharing `schema_migrations`.

**`d1File` passes no `--json` and parses nothing.** With `--file` wrangler prints progress
lines before any JSON, so `JSON.parse` throws on the first character — AFTER the
statements have run, which is the worst possible place to throw. It left 003 applied but
unrecorded. A non-zero exit already throws from `execFileSync`.

**A migration that backfills must account for rows with `cat_id IS NULL`.** 002 made the
Worker mint a cat per upload but never went back for existing rows, so 003 had to mint
them itself — otherwise their tags were dropped on the floor, since the backfill can only
reach a cat through `cat_id`. Linking row-to-new-row in plain SQL needs a marker
(`notes = 'migrate:<id>'`), written, read back and cleared inside the migration.

**Dry-run a destructive migration against a local SQLite copy first** (`executescript` on
the real files, seeded with the real data shape). That is what caught the orphan case.
And take a `npm run backup` before applying.

## Editing

- **The sheet is a glance; `#/sighting/<id>` is the only editor.** Two editors that must
  agree is a bug factory.
- **Edits accumulate locally and save on a button**, never per tap: every PATCH is a D1
  write plus an `app_meta` bump against a hard 100k/day cap. The body carries only the
  fields that actually changed.
- **Re-render is suppressed while an input has focus or an edit is unsaved** — the store
  fires on every refresh, including the one a save triggers.
- **A cat with zero sightings is an artefact, never intentional**, and is filtered out
  of the Cats list. Grouping creates the cat before attaching sightings, so a failure
  part-way (or unlinking the last one) leaves a shell that rendered as a grey box
  captioned "seen 0 times" and read as a broken photo.
- **`openDetail` records that the layer is open BEFORE mounting, and guards the mount.**
  It used to set `detail` afterwards, so a page that threw left the sheet visible with
  `detail === null` — and `closeDetail` returned early, leaving a blank panel that
  nothing could dismiss until a reload. `closeDetail` now hides unconditionally.
- **Detail views and the bottom sheet have NO back button — you swipe them down.** Both
  stop short of the top edge so the page behind shows, both wear a grabber, and in both
  a drag only starts on the grabber or at scrollTop 0 (otherwise a downward flick
  mid-content dismisses instead of scrolling). The grabber is also a tap target: a
  gesture with no fallback strands anyone who does not discover it.
- **Standalone action buttons are full width.** A lone button at its text width, inset
  from the page edge, reads as floating debris — and a destructive one looked like it
  belonged to whatever happened to sit above it.
- **`.pad` sets `overflow-x: hidden`.** Every card carries a hand-stuck rotation, and a
  rotated box sticks out past its layout width, so a grid reaching the container edge
  produces a sideways scroll that looks like a bug and is the design working.
- **Action bars use `justify-content: space-between`, never `margin-left: auto`.** An
  auto margin on an overflowing flex line pushes the first item off the left edge.
- **The sheet swipe is rAF-batched, and its velocity is measured over the last ~100 ms.**
  Writing the transform straight from `touchmove` stutters, because iOS fires it faster
  than it paints. Averaging velocity from `touchstart` meant a quick flick followed by
  holding still still read as fast, so the sheet flew away after she had decided not to
  dismiss it — stopping must be a real cancel. The commit threshold is SUBTRACTED from the
  offset or the sheet jumps under the finger, and tracking is 1:1, as every iOS sheet is.
- **Do not judge a gesture's direction from the first touchmove.** The first millimetre
  is jitter, so comparing dx to dy across it is decided by noise: a genuine downward drag
  that starts 2px to the left reads as horizontal, gets handed to the page, and — because
  `dragging` is false for the rest of the gesture — CAN NEVER RECOVER. That made
  swipe-to-dismiss feel dead. Commit to nothing below the slop threshold.
- **A Leaflet map owns its own drag**, so the sheet gesture ignores touches starting
  inside `.leaflet-container`. Without it, panning a mini-map drags the sheet down with it
  and the page appears to scroll on its own.
- **Mini-maps use a ResizeObserver (`minimap.js`), never a bare rAF.**
  `requestAnimationFrame(() => map.invalidateSize())` is a GUESS ABOUT TIMING — one frame
  is enough when the sheet is already open and not enough while it is animating, which is
  why the territory map loaded "sometimes". Leaflet measures its container once and never
  notices it changing; the observer fires whenever the box actually changes.
- **Action bars are a GRID, not flex.** An overflowing flex line can push its first item
  outside the container: "Undo" ended up off the left edge with its border clipped through
  two attempted fixes (`margin-left:auto`, then `justify-content`). Grid tracks clamp
  their children, so the failure mode is structurally impossible rather than discouraged.
- **A revealed picker must scroll itself into view.** Showing faces below the fold and
  leaving the page where it was reads as the button having done nothing.
- **Photos are never cropped to a fixed pixel height.** `object-fit: cover` on a fixed
  height cut most of the cat out of a portrait shot. Height follows the image's own aspect
  ratio, capped with `max-height`, and `contain` letterboxes onto the paper mount — which
  on a print is what a mount is for. Pass `width`/`height` attributes so layout is
  reserved before the image loads.
- **A pin is a little polaroid**: white mount, a deep chin below a square photo window,
  the cat's colour as the die-cut ring. The window stays square so a pin is a predictable
  size whatever shape the photo is; the print around it is what makes it an object.
- **The map opens on the Victoria bounds on EVERY fresh page load**, whatever was saved
  and wherever the cats are. `lastView` only survives switching tabs within one session,
  which is the case it was for. A module-level `firstMount` flag is "fresh load", since
  the module is evaluated once per load.
- **A cat's name is a CAT NAME TAG with ears**, in the handwritten face. The ears live on
  a `.tag` WRAPPER because an `<input>` renders neither `::before` nor `::after`, and they
  are ink-outlined diamonds rather than clip-path triangles — `clip-path` cuts the border
  off with the shape, and the ink outline is the whole look. The tag body is
  `position: relative` so it paints over their lower halves and only the points show.
- **A cat's name is a slanted NAMEPLATE, not a form field.** The dashed outline it
  replaced is this app's vocabulary for "unselected chip", so borrowing it for a text box
  said the name was an option not yet taken. Unnamed lies flat via `:placeholder-shown` —
  same physics as a chip. It is still an `<input>`: tap it and type, no mode, no button.
- **Where a date is shown, the relative time is NOT also shown.** "9 days ago · September
  4th" says the same thing twice; the absolute date is the one she cannot work out
  herself. Format is `September 4th 1:26pm`, and the ordinal has the 11-13 exception every
  naive version gets wrong.
- **Destructive actions arm on the first tap and fire on the second.** No `confirm()`:
  a native dialog in a standalone app looks like the browser breaking through.
- **Multi-step mutations are not atomic and must fail visibly**, not roll back. Grouping
  is `POST /cats` + N PATCHes; ungrouping unlinks *before* deleting the cat, so a
  part-way failure leaves loose sightings rather than dangling references.
- **Every mutation is audited, successes included.** The flush originally ran only in the
  error path, so the log held nothing but `/pass` rows and "did this upload land, and what
  did it do" was unanswerable. Exactly ONE row is written per request — the last entry
  pushed — because two would break the 4-rows-per-upload budget.
- **`ensurePass()` short-circuits on a stored pass.** It used to run the full Turnstile
  flow on every save; the first device test logged three solves in four minutes. A 401
  uses `renewPass()` instead, which clears first — reusing a rejected pass loops forever.
- **`accuracyM` must be a whole number.** The Worker validates it with `int()`, both real
  sources are floats (EXIF 9.98, `coords.accuracy` a double), and the outbox treats a 400
  as terminal — so an unrounded value fails every upload permanently. Rounded once in
  `resolveLocation`; guarded by a test.

## Gotchas in this environment

- **Headless Firefox screenshots hang here**, even on a trivial page — spirit-tracker's
  documented `--screenshot` trick is unavailable. Verify markup structurally instead (JS
  parses, tags balance, external URLs 200) and get Brennan to look at anything visual.

## Admin scripts

All under `worker/scripts`, all remote, all dry-run by default where they destroy.

| | |
|---|---|
| `npm run photos` | **Interactive full-screen browser.** j/k to move, space to mark, `d`/`D` to delete one or all marked, `o` to open in a browser, `-- --all` to include tombstones. Shows the photo inline on kitty/Ghostty/WezTerm/iTerm2, or via `chafa`/`viu` if installed |
| `npm run backup` | Dump every table to `backups/meowmap-<ts>.json`. `--photos` also downloads the images, which is the only part R2 cannot give back |
| `npm run restore <file>` | REPLACES the tables from a backup, preserving ids. `--check-photos` first says which images still exist |
| `npm run purge -- …` | `--sighting`/`--cat`/`--before`/`--all`, `--apply` to commit |
| `npm run wipe` | `purge --all --apply --yes-really` |
| `npm run reconcile` / `gc` | Recompute R2 counters; `gc` also deletes unreferenced objects |
| `scripts/db-sql 'SELECT …'` | Read-only escape hatch. Refuses to write |

The TUI is hand-rolled in `tui.mjs` + `preview.mjs` — **no dependency, deliberately**.
This repo has zero runtime deps in the Worker and zero in the frontend; pulling in ink
(and React, and a build step) to draw three boxes would be the largest dependency in the
project. Image preview hands the terminal the raw JPEG and lets it decode, so there is no
image library either. `tui.test.ts` covers the part that actually breaks: visible width
must ignore ANSI escapes, or every box drawn around coloured text comes out ragged.

**The interactive browser is one key handler and one `mode` variable.** An earlier
version awaited a nested key listener for the confirmation prompt; its teardown called
`stdin.pause()` and `setRawMode(false)`, which are process-wide, so it took the main
listener with it and the app stopped responding after the first confirmation. **A modal
is a mode, not a second listener.**

**Announce before you block.** Every wrangler call is synchronous and spawning `npx`
costs seconds before it does any work, so the UI must paint its "working…" frame and
yield to the event loop *first*. Use `d1Many` to put several statements in one
invocation — a delete built from four separate calls spent most of its time starting
processes, which is what made it feel hung.

**`npm run migrate` applies migrations with your wrangler login, no token.** CI does the
same through `ensure-bindings.mjs` against the same `schema_migrations` table, so they
agree. It exists because an admin script that cannot run until you deploy is useless
exactly when the thing you are fixing is the data — `npm run gc` failed with "no such
table: r2_gc_queue" for precisely that reason. The scripts that need the journal apply
pending migrations lazily rather than surfacing a raw SQLITE_ERROR.

**Strip SQL comments BEFORE splitting on `;`.** 001's omission log contains "read with a
bare SELECT; an index would be…", which split mid-sentence and sent `an index would be…`
to D1 as a statement.

**`package.json` documents every script** with a `//name` key above it — the scripts block
has no comment syntax and this is the established idiom.

**Three traps these scripts exist to have already hit:**

- **The command is `wrangler r2 object delete <bucket>/<key>`**, NOT
  `wrangler r2 bucket object delete`. The wrong form is a plausible guess, and wrangler
  answers it with a bucket help dump that never mentions the real command.

- **`database_id` in `wrangler.toml` is the literal `__D1_ID__`.** CI patches it at deploy;
  nobody patches it locally. Passing the *name* does not help — wrangler resolves the name
  against the config and then calls the API with the placeholder. So `cf.mjs` and
  `db-common` look the UUID up via `wrangler d1 list`. The old helpers also piped stderr to
  `/dev/null`, which made a broken script and an empty table look identical for days.
  **Never swallow stderr in these scripts.**
- **Wrangler has no `r2 object list`** (only get/put/delete), so listing needs the REST API
  and a token. Scripts that merely delete known keys compute reachability in SQL instead
  and stay on OAuth alone.

**Deleting photos is always reachability-based**, never "delete the hashes of the row I
just removed": keys are content-addressed, so two sightings can share one object.

**Row first, object second, and a failed object delete is reported, never thrown.** The
reverse order leaves a row pointing at a photo that does not exist, which is worse than
an orphaned object. This order can strand an object, which `npm run gc` sweeps — and a
throw mid-loop strands it with nothing left in D1 naming it, which is how the first real
run lost track of two objects.

`purge.mjs` HARD-deletes while the app soft-deletes. The app tombstones because recycled
rowids would re-point an offline client's cache; that is about live data. Test data you
want gone should not keep pinning R2 bytes forever.

`reconcile` recomputes true R2 bytes/objects from the bucket, because the counters are
incremental and `r2_reads_est` is 1-in-100 sampled, so they drift. It needs
`CLOUDFLARE_API_TOKEN` (the listing problem above). **There is no separate `r2-gc.mjs`
and there should not be** — one reachability union, or the two copies drift. Its
reachability includes soft-deleted rows, since tombstones pin their bytes so undelete is
free, and it reports `referenced − listed` (a row whose photo is gone) without ever
auto-fixing it: that needs a human.

## Reference

- Plan: `~/.claude/plans/take-a-look-through-imperative-hejlsberg.md` — full build order,
  route table, schema rationale, free-tier budget.
- Sibling projects worth copying from: `~/vessel-tracker` (worker layout, `ensure-bindings.mjs`,
  `db-*` scripts, Leaflet patterns), `~/spirit-tracker-api` (`jwt.ts`, `base64url.ts`),
  `~/spirit-tracker/viz` (mobile CSS discipline, `dom.js`).
