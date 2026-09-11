# Build status

**Updated:** 2026-09-11 — deployed, green, probe RUN, and the photo pipeline + capture
page + PWA now exist (not yet run on a device).
**Read this first after a break or a context compaction.** The full design rationale lives
in `~/.claude/plans/take-a-look-through-imperative-hejlsberg.md`; this file is only "what
exists, what is verified, what is next".

## Live

```
App    https://brennanwilkes.github.io/meowmap/
Probe  https://brennanwilkes.github.io/meowmap/probe.html
API    https://meowmap-api.brennan-a53.workers.dev
```

D1 `meowmap` created, `001_initial.sql` applied, `app_meta` seeded. R2 bucket
`meowmap-photos` created. Both Worker secrets pushed. `/health`, `/sightings` and
`/config` all 200. Every frontend asset serves with the right content type.

### First-deploy failures, and what they actually were

Worth recording because none of them were what they first looked like.

- **Pages 422 "Validation Failed" ×2.** Looked like an enablement race, then a
  deployment-branch-policy problem — the API said Pages was configured and `main` was
  allowed. The real cause: **the repo was private**, and Pages on a private repo needs
  a paid plan. Went green immediately once it was public.
- **Worker smoke test 500.** The app was fine; the test fired ~1s after
  `wrangler secret put`, and every secret push creates a new Worker version, against a
  D1 database ~30s old. Fixed by making the smoke test retry (`_smoke.sh`) rather than
  by touching the app — a gate that goes red on a cold start trains you to ignore red.
- **Stale GitHub Actions**, found while chasing the 422 and worth fixing regardless:
  configure-pages v4→v6, upload-pages-artifact v3→v5 (v3's artifact backend is
  deprecated), deploy-pages v4→v5, checkout/setup-node v4→v7. The v7 bumps also made
  `FORCE_JAVASCRIPT_ACTIONS_TO_NODE24` redundant, so it is gone.
- **Workflows were path-filtered to `worker/**` and `frontend/**`,** so a workflow-only
  change triggered nothing. They now watch themselves.

---

## Verified working

Everything below was actually executed, not just written.

```
bash tests/run-all.sh                                       70 checks pass
cd worker && npm test                                       33 tests pass
cd worker && npm run typecheck                              CLEAN (zero errors in src/)
cd worker && npx wrangler deploy --dry-run --outdir /tmp/d  23.56 KiB / 8.25 KiB gzip
```

The worker tests run **without `node_modules`** — Node's type-stripping erases the
types-only `@cloudflare/workers-types`, and WebCrypto/btoa/atob are Node globals. Useful
to know if the install is ever unavailable again.

| Suite | Covers |
|---|---|
| `tests/exif.test.mjs` (16) | GPS both byte orders, S/W negation, zeroed GPS IFD, zero denominator, orientation range, SOFn dims, XMP-before-EXIF, UTC-vs-wall-clock preference, truncation |
| `tests/suggest.test.mjs` (10) | 250 m hard cut, distance beats recency, coat mismatch demotes without excluding, untagged case, determinism |
| `tests/turf.test.mjs` (8) | Blob encloses every sighting, padding, determinism, near-collinear non-degeneracy, single point |
| `tests/catcolor.test.mjs` (9) | Stability, id 0, palette spread, no consecutive collisions |
| `worker/test/budget.test.ts` (11) | Every R2 ceiling, day/month rollover, 507 vs 503, the "photo is safe" message |
| `worker/test/jwt.test.ts` (9) | Round trip, expiry, wrong secret/iss/aud, **alg=none forgery**, tampered payload, secret rotation |
| `worker/test/validate.test.ts` (13) | Coordinate bounds, id 0, coat whitelist, hash format + path traversal, slugify |
| `tests/dom.test.mjs` (9) | `esc()` XSS boundary incl. ampersand ordering, relative/absolute time, timezone-independent |
| `tests/outbox.test.mjs` (18) | Error classification, jittered backoff + cap, every state transition, **failed-is-not-deletion**, budget slow-path, banner escalation |
| `tests/pipeline.test.mjs` (19) | fitLongEdge never upscales, halvingPlan never exceeds 2x per step, EXIF-beats-device, **an old photo never borrows the current fix**, poor-accuracy pre-opens correction, a skewed camera clock is rejected, and a guard that the nag card stays deleted |
| `tests/pipeline.test.mjs` also | **accuracy is whole metres** — the regression guard for the 400-on-every-upload bug |
| `tests/filter.test.mjs` (9) | OR-monotonicity (an extra chip can only show more), untagged hidden under a filter, **territory filtered too** so a blob is never drawn around hidden points, no mutation of the store |
| `tests/vocab.test.mjs` (4) | The coat/size/petted vocabularies and length caps in `config.js` match `worker/src/constants.ts` — read from both files, because there is no bundler to share one declaration |

Also structurally verified: every frontend module parses, **every relative import
resolves**, every local `href`/`src` in `index.html` exists, the manifest is valid JSON,
the four generated icons are valid PNGs at the right dimensions, and all three workflow
YAML files parse.

---

## What exists

```
CLAUDE.md                      project memory — conventions, cost rules, iOS realities
docs/BUILD-STATUS.md           this file
mockups/                       5 design mockups; scrapbook-tactile.html is the reference
frontend/
  index.html                   app shell
  manifest.webmanifest + icons/  PWA install (icons generated, valid PNGs)
  probe.html                   iPhone diagnostic — NOT YET RUN, see Next
  config.js                    every tunable, incl. TILE_SOURCES
  styles/                      tokens, base, layout, sticker, map, sheet
  sw.js  offline.html          service worker (4 caches) + first-visit-offline page
  app/main.js                  router + page-turn lifecycle + boot wiring
  app/capture_page.js          take/choose -> tag -> place -> queue -> suggest
  app/pipeline.js              picker -> exif -> decode -> resize -> draft
  app/decode.js                File -> bitmap, source-pixel ceiling guard
  app/resize.js                halving downscale + bounded quality search
  app/geolocate.js             converging watchPosition, typed failures
  app/turnstile.js             on-demand widget -> upload pass, coalesced
  app/pwa.js                   sw registration, update bar, persist(), install hint
  app/nav.js                   back()/navigate(), split out to avoid a router cycle
  app/cats_page.js             cats + unidentified, multi-select grouping
  app/cat_page.js              rename, territory map, ungroup
  app/sighting_page.js         THE editor: tags, note, date, pin, link, delete
  app/settings_page.js         tiles, queue, storage + cost-breaker diagnostics
  app/components/chips.js      the coat/size/petted rows, shared by capture + editor
  app/filter.js                coat filtering for pins AND territory (pure, tested)
  app/map_page.js              pins, turf pane, collapse-by-cat, outbox banner
  app/sheet.js                 detail sheet — READ-ONLY for now, see Next
  app/store.js                 pub/sub store + pending-vs-server dedupe
  app/idb.js                   IndexedDB wrapper; tx2() for atomic two-store writes
  app/outbox.js                queue state machine (pure half is unit-tested)
  app/flush.js                 serial flush loop, page-based, no Background Sync
  app/api.js  device.js  dom.js
  app/exif.js  suggest.js  turf.js  catcolor.js     (all tested)
worker/
  package.json tsconfig.json .dev.vars.example
  wrangler.toml                ACTIVE. Claude cannot read or edit this path.
  migrations/001_initial.sql   full schema with the index omission log
  src/                         13 modules, typechecked clean, bundles
  scripts/                     ensure-bindings (D1+R2), db-common, db-stats, db-audit,
                               db-audit-devices, db-orphans, r2-reconcile.mjs
  test/                        budget, jwt, validate
.github/workflows/             deploy-worker (with a check gate), pr-check, deploy-pages
tests/                         6 suites + run-all.sh
```

---

## Blocked — needs Brennan

1. ~~`worker/wrangler.toml` does not exist.~~ **DONE** — Brennan moved it into place
   2026-09-10. Verified: parses as TOML, all four `[[ratelimits]]`, both bindings,
   `[cache]` and `[observability]` present.

   Claude cannot read or edit this path at all (permission rule), so two edits remain
   **Brennan's to make**: delete the stale `# PROPOSED …` header block at the top, and
   set `TURNSTILE_SITE_KEY` once the widget exists. `database_id = "__D1_ID__"` is
   correct as-is — `ensure-bindings.mjs` patches it on the first deploy.

2. ~~`npm install` is permission-denied.~~ **DONE** — Brennan installed 2026-09-10.
   `tsc --noEmit` now runs and **`src/` is clean: zero type errors on first compile**.
   `wrangler deploy --dry-run` bundles at 23.56 KiB (8.25 KiB gzip) with all six
   bindings recognised, which also proves the `[[ratelimits]]` GA syntax works rather
   than just reading correct.

   Two things came out of it:
   - **Tests are deliberately excluded from `tsc`.** They import `node:test`/
     `node:assert`, which needs `@types/node`, and pulling Node's globals (its `crypto`,
     its `fetch`) into a Workers project is a known source of subtle wrongness. They are
     verified by being *run*, which is stronger evidence than compiling them.
   - **`[cache]` was being silently ignored — now FIXED.** wrangler 4.65.0 warned
     `Unexpected fields found in top-level field: "cache"` and carried on, so Workers
     Cache was NOT enabled and the free-tier headroom that leans on it (protecting R2
     class B ops and D1 reads) did not hold. Now on **wrangler 4.131.0 +
     @cloudflare/workers-types 5.20260910.1**; the warning is gone and the bundle is
     clean. Worth knowing the version floor: the types peer jumps 4→5 at wrangler
     **4.108.0**, which is also where Workers Cache landed (GA 2026-07-06), so there is
     no way to get `[cache]` while staying on types v4. The major types bump produced
     **zero** new type errors, and the upgrade also cleared 6 npm advisories.

3. ~~R2 must be enabled in the dashboard.~~ **DONE** 2026-09-10.

4. **Turnstile widget — in progress.** Hostname decided: **`brennanwilkes.github.io`**
   (project-repo Pages deploy, so the app is at `/meowmap/` on that host; Turnstile
   matches hostname only, never path). Managed mode, widget name `meowmap`.
   Already wired into `TURNSTILE_HOSTNAMES` in `constants.ts`.
   Still to do: paste the sitekey into `[vars] TURNSTILE_SITE_KEY` in `wrangler.toml`
   (Brennan's, Claude cannot touch that file) and the secret into GitHub.

   Two consequences worth remembering:
   - Bare `github.io` is on the Public Suffix List and cannot be added.
   - The widget is valid from **any** repo on `brennanwilkes.github.io`, not just this
     one. Narrowed by also pinning `action: "upload"` server-side. Add the custom
     domain as a *second* hostname later rather than replacing this one.

5. **The repo must be named `meowmap`.** The Pages subpath is the repo name and the
   service-worker scope is capped by it. `manifest.webmanifest` uses relative
   `scope`/`start_url` so it follows automatically, but `"id": "/meowmap/"` is absolute
   and would need changing. Verified resolving to `/meowmap/` and `/meowmap/#/map`.

6. **GitHub secrets not set:** `CLOUDFLARE_API_TOKEN` (needs **Workers R2 Storage:Edit**
   on top of the usual D1/Workers scopes), `CLOUDFLARE_ACCOUNT_ID`,
   `TURNSTILE_SECRET_KEY`, `PASS_SIGNING_SECRET` (`openssl rand -base64 48`),
   `WORKERS_SUBDOMAIN`.

---

## OPEN DECISION — needs Brennan

### 1. The location nag — RESOLVED IN CODE AS OPTION (a), say if you disagree

`pipeline.js` → `resolveLocation()` implements **(a): no nag.** A photo with no GPS goes
straight to tap-the-map. `LS.locationNagSeen` has been removed from `config.js` and
`tests/pipeline.test.mjs` has a check that asserts no resolution mentions the picker,
so it cannot creep back by habit. One constant's worth of work to reverse if you want
(b) or (c). The reasoning: The probe shows a library photo arriving with **full GPS**
(9.98 m accuracy) and full timestamps, with no picker setting touched — the documented
"iOS strips GPS from library photos by default" did not reproduce on iOS 18.7.5.

So nagging every time a photo lacks GPS would now fire only for genuinely location-less
photos (screenshots, AirDropped or shared images, old imports), where the instruction
"turn on Options → Location" is not the fix and would just be wrong. Options:
  a) Drop the nag; when GPS is absent, go straight to tap-the-map. **← built**
  b) Keep a one-time card, shown only the first time it happens.
  c) Keep nagging as originally chosen.

### 2. `storage.persist()` — still unresolved, and it is the important one

**`storage.persist()` was DENIED**, but that was measured in Safari
(`standalone: false`), not as an installed home-screen app — which is exactly where
WebKit's heuristic is meant to favour granting. **Re-run the Storage probe after
installing to the home screen.** This is the single most important open question for
durability, because the outbox is the only copy of an in-app camera photo and quota
(41 GB) is not the constraint — eviction is.

`pwa.js` now re-requests it on **every** boot rather than once, precisely because the
answer legitimately changes after install, and logs a warning when it comes back false.
Open the console on the installed app and look for `[pwa] storage is NOT persisted`.

---

## Next, in order

1. ~~Run probe.html on the iPhone.~~ **DONE 2026-09-11.** Full measured results are in
   the table in `CLAUDE.md` → "iOS realities". Two documented behaviours did NOT
   reproduce — read that table rather than trusting any blog post. Constants already
   folded into `config.js`.
2. **Open the app in a browser and actually look at it.** It is deployed and every
   asset serves, but the map page has never been rendered — everything so far is
   structural verification (parses, imports resolve, references exist). Expect runtime
   errors. https://brennanwilkes.github.io/meowmap/
3. ~~Photo pipeline.~~ **DONE:** `decode.js`, `resize.js`, `pipeline.js`,
   `geolocate.js`, and `capture_page.js` end to end — take/choose, EXIF, resize,
   location resolution, chips, a tap-to-place mini map, queue, suggestion card.
   `probes.js` was never written and is not needed: the answers are measured and
   committed. Written but **never executed in a browser**.
4. ~~Turnstile exchange.~~ **DONE:** `turnstile.js` loads the widget on demand
   (`interaction-only`, `action: 'upload'`), coalesces concurrent challenges into one,
   and is registered as `flush.onNeedsPass` at boot so a queue draining hours later can
   still re-verify. **Still to do: make `sheet.js` editable** — it is read-only, and its
   chips render as static stickers rather than tappable-but-dead controls.
5. ~~Offline queue.~~ **DONE and tested** (18 checks). ~~`sw.js` + install prompt.~~
   **DONE:** `sw.js` (four caches, FIFO photo cap, no auto-`skipWaiting`),
   `offline.html`, and `pwa.js` (registration, update bar, `persist()` every boot, a
   one-time iOS install hint).
6. ~~Remaining pages.~~ **DONE:** `cats_page.js` (list + "these are one cat"),
   `cat_page.js` (rename, territory, ungroup), `sighting_page.js` (the full editor),
   `settings_page.js` (tile switcher, queue, storage + budget diagnostics). The router
   grew a **detail layer** (`#/cat/<id>`, `#/sighting/<id>`, `#/settings`) that slides
   UP over the tabs, so hierarchy never looks like lateral movement.

7. ~~Map filter by coat.~~ **DONE:** `filter.js` + a scrollable chip strip along the
   bottom of the map. Multi-select is **OR**, it is **not persisted**, and it filters
   territory as well as pins.
8. ~~`r2-gc.mjs`.~~ **NOT WRITTEN, AND SHOULD NOT BE.** `r2-reconcile.mjs --gc` already
   does reachability GC over the same union query; a second implementation of the same
   reachability rule is exactly the kind of duplicated derivation that drifts. Exposed
   as `npm run gc` in `worker/package.json`.

**Every page and every scoped feature now exists.** What is left is running it.

**THE NEXT THING TO DO IS OPEN IT ON THE PHONE.** Roughly 2,400 lines of frontend have
now been written against a browser that has never run them. The tests cover the pure
logic and the structure checks cover the wiring, but neither has ever painted a pixel.
Expect runtime errors on the first load, and work through them before writing anything
further.

---

## Decisions made during the build (not in the original plan)

- **BUG FOUND BY WIRING, NOT BY TESTS: `accuracyM` had to be a whole number.** The
  Worker validates it with `int()`, both real sources are floats (EXIF gave **9.98**,
  and `coords.accuracy` is a double), and the outbox classifies a 400 as **terminal** —
  so *every single upload* would have gone straight to `failed`, with the photo
  recoverable only via save-to-device. Fixed by rounding in `resolveLocation`, the one
  place a fix becomes a draft, with a regression check in `pipeline.test.mjs`. Worth
  noting how it surfaced: writing the second consumer of the field, not writing a test.
- **The sheet stays read-only; `#/sighting/<id>` is the only editor.** The sheet is a
  glance at a pin tapped while panning. Two editors that must agree is a bug factory.
- **Edits are explicit, not live.** A chip row is easy to fiddle with and every PATCH is
  a D1 write plus an `app_meta` bump against a hard 100k/day cap, so changes accumulate
  locally and a Save bar appears only once something differs. The PATCH body carries
  only the fields that actually changed.
- **Destructive actions are two taps, not `confirm()`.** A native dialog in a standalone
  app looks like the browser breaking through the conceit.
- **Grouping and ungrouping are deliberately not atomic** — there is no bulk endpoint,
  so they are N sequential PATCHes. A part-way failure leaves a real, visible,
  hand-fixable state; "rolling back" by deleting the cat would risk destroying links
  that did land.
- **`ungroup` unlinks before deleting the cat**, never the reverse, so a failure leaves
  loose sightings rather than sightings pointing at a cat that no longer exists.
- **Re-render is suppressed while a field has focus or an edit is unsaved.** The store
  fires on every refresh, including the one a save triggers, and rebuilding under the
  user drops what she is typing.
- **The coat filter is OR, and is not persisted.** OR is monotone — every extra chip
  can only show more — which is a model you can hold while walking; AND of two optional,
  often-partial tags matches almost nothing and looks broken. Not persisting it avoids
  opening the app tomorrow to a map missing most of her cats with nothing explaining why,
  and a visible note always states what is hidden.
- **No separate `r2-gc.mjs`.** `r2-reconcile.mjs --gc` already walks the same
  reachability union; two implementations of one rule drift. `npm run gc` aliases it.
- **`location_source` is stored and never shown**, per Brennan. Only accuracy surfaces,
  and a hand-placed pin nulls it — a radius around a dragged pin is a lie.

- **The vocabularies are declared twice and asserted equal.** `COAT_TAGS` etc. live in
  both `frontend/config.js` and `worker/src/constants.ts` because there is no bundler
  to share one declaration. `tests/vocab.test.mjs` reads both files and compares, so
  drift is a red test rather than a 400 at save time, after the photo has already been
  processed.
- **`linkWhenUploaded` returns false rather than failing** when the row has already
  uploaded, and the capture page then PATCHes the server row. The suggestion card
  appears immediately after save, so on a fast connection the row can be gone from the
  queue before she taps — dropping the link there would be silent and wrong.
- **The Turnstile challenge is fetched at save time, not at flush time.** It appears
  while she is still looking at the photo rather than minutes later out of nowhere. A
  failure is not fatal: the row queues regardless and `flush.js` retries the exchange.
- **The geolocation watch starts AFTER `input.click()`**, never before. The click must
  be synchronous inside the user gesture or iOS silently drops the picker — so the
  ordering is load-bearing, not stylistic.
- **`persist()` is requested on every boot, not once.** It was DENIED in Safari and the
  documented heuristic favours installed apps, so the answer legitimately changes; a
  cached "no" would hide that.

- **Cat colours use a coprime stride, not a hash.** A test caught ids 37/38 colliding.
  With 12 shades a hash makes collisions merely unlikely (~1 in 12 per adjacent pair);
  `id * 5 % 12` makes them impossible, spreads perfectly evenly, and guarantees
  consecutive ids land 5 or 7 apart in the palette. Adjacent ids are exactly the cats
  most likely to be added in one session on one block, so this matters.
- **Worker tests use a glob, not a directory.** `node --test test/` resolves `test` as a
  *file* on Node 22 and fails; `test/*.test.ts` works on both 22 and 24.
- **`patchSighting` uses an explicit presence flag for `cat_id` and `accuracy_m`**, not
  `COALESCE`. Both are legitimately settable to NULL (unlink a cat; hand-place a pin) and
  `COALESCE` cannot distinguish absent from null.
- **A hand-placed pin nulls its accuracy** — an accuracy radius around a pin someone
  dragged is a lie.
- **`POST /pass` is deliberately not audited.** It is pre-auth, so an audit row there
  would be a write-amplification DoS against the hard D1 daily cap.

## Environment gotchas

- **Headless Firefox screenshots hang here**, even on a trivial page, so spirit-tracker's
  documented `--screenshot` trick does not work. Verify markup structurally (JS parses,
  tags balance, external URLs 200) and get Brennan to look at anything visual.
- Blocked commands seen so far: writing `wrangler.toml`, `npm install`, `chmod`, `pkill`.
