# Build status

**Updated:** 2026-09-11, after the first round of unblocking.
**Read this first after a break or a context compaction.** The full design rationale lives
in `~/.claude/plans/take-a-look-through-imperative-hejlsberg.md`; this file is only "what
exists, what is verified, what is next".

Nothing has been committed and nothing has been deployed. `git init` has run; there are no
commits yet.

---

## Verified working

Everything below was actually executed, not just written.

```
bash tests/run-all.sh                                       52 checks pass
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
  app/main.js                  router + page-turn lifecycle
  app/map_page.js              pins, turf pane, collapse-by-cat, outbox banner
  app/sheet.js                 detail sheet — READ-ONLY for now, see Next
  app/store.js                 pub/sub store + pending-vs-server dedupe
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
tests/                         5 suites + run-all.sh
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

## Next, in order

1. **Run `frontend/probe.html` on the real iPhone**, over HTTPS. It is the outstanding
   Phase 0 item and it answers the questions the photo pipeline is currently guessing at:
   what a `capture=` photo actually contains, whether the picker's Location toggle is
   *sticky* across launches, what HEIC arrives as, whether `createImageBitmap` honours
   `resizeWidth`, and whether `storage.persist()` is granted. Fold the answers into
   `decode.js`/`resize.js` constants before writing them.
2. **Open the app in a browser.** It has never been rendered — everything so far is
   structural verification. Serve `frontend/` statically and point `config.js`
   `API_BASE` at a local `wrangler dev`. Expect runtime errors; nothing here has
   executed in a DOM.
3. Photo pipeline: `decode.js`, `resize.js`, `pipeline.js`, `probes.js`, `geolocate.js`.
   Use the probe results from step 1 for the constants.
4. Turnstile exchange, then make `sheet.js` editable — it is read-only today because
   editing needs an upload pass. Chips render as static stickers rather than as
   tappable-but-dead controls.
5. Offline: `idb.js`, `outbox.js`, `flush.js`, `sw.js`.
6. Remaining pages: capture, cats, cat, sighting, settings. Snap and Cats are
   placeholder page modules in `main.js` today.

---

## Decisions made during the build (not in the original plan)

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
