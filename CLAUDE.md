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

## iOS realities that shaped the build

- **GPS EXIF is stripped from library photos by default** (WebKit 207088); it's opt-in per
  upload via the picker's Options → Location. So "use the photo's location" is the
  exception, not the rule, and manual pin placement is a first-class flow.
- **`capture=` photos have all EXIF stripped and never reach the camera roll.** Combined
  with not storing originals, an evicted outbox means the photo is gone forever — hence
  persistent storage, a loud pending banner, and save-to-device on every queued item.
- **`accept="image/heic"` makes Safari 17+ transcode JPEGs *into* HEIC.** Use
  `image/jpeg,image/png`.
- **Background Sync has never shipped in Safari.** Do not write one, even guarded. The
  flush loop lives in the page.
- **Canvas silently yields a blank image above `w*h > 16,777,216`** — no exception. Catch
  oversized sources before decode using the SOFn dimensions from the EXIF pass.
- **`canvas.toBlob` silently falls back to PNG** for an unsupported type. JPEG only.
- EXIF must be read from the original bytes *before* any canvas work; canvas re-encode
  destroys all metadata unconditionally.

## Gotchas in this environment

- **Headless Firefox screenshots hang here**, even on a trivial page — spirit-tracker's
  documented `--screenshot` trick is unavailable. Verify markup structurally instead (JS
  parses, tags balance, external URLs 200) and get Brennan to look at anything visual.

## Reference

- Plan: `~/.claude/plans/take-a-look-through-imperative-hejlsberg.md` — full build order,
  route table, schema rationale, free-tier budget.
- Sibling projects worth copying from: `~/vessel-tracker` (worker layout, `ensure-bindings.mjs`,
  `db-*` scripts, Leaflet patterns), `~/spirit-tracker-api` (`jwt.ts`, `base64url.ts`),
  `~/spirit-tracker/viz` (mobile CSS discipline, `dom.js`).
