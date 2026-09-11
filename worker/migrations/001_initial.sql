-- Meowmap initial schema.
--
-- CONVENTIONS
--   * Every timestamp is INTEGER epoch-ms. Never TEXT dates.
--   * INTEGER PRIMARY KEY only (a rowid alias, zero extra cost). NEVER AUTOINCREMENT:
--     it adds a sqlite_sequence UPDATE — a second row WRITTEN — to every INSERT, buying
--     a monotonicity guarantee we get free by never hard-deleting.
--   * Rows are SOFT-deleted (deleted_at). Not squeamishness: rowids are recycled after a
--     DELETE, and a recycled id would silently re-point every offline client's cached
--     record at a different cat.
--
-- INDEX POLICY
--   In D1 every secondary-index entry is a row WRITTEN against the 100k/day free cap,
--   which has been hard-enforced since 2026-09-01 (queries fail until midnight UTC). An
--   index that does not earn its keep on reads is a permanent tax on every write. Each
--   index below carries its justification; the ones deliberately NOT created are logged
--   at the bottom. Keep that log current.

-- ── cats ─────────────────────────────────────────────────────────────────────
CREATE TABLE cats (
  id         INTEGER PRIMARY KEY,
  name       TEXT,                    -- nullable: an unnamed cat is a normal, permanent state
  slug       TEXT,                    -- null when unnamed; see the unique index below
  notes      TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);

-- INDEX 1 of 2, JUSTIFIED.
-- A correctness constraint, not a read optimisation: two live cats named "Mochi" would
-- silently fork one cat's history and there is no un-fork. SQLite treats NULLs as
-- distinct, so unnamed cats are exempt for free. Partial on deleted_at so a name can be
-- reused after a delete. Key columns change only on a deliberate rename, so no
-- frequently-updated column sits in the key — the mistake that cost vessel-tracker
-- 12k writes/day on zone_visits(zone_id, last_ts).
-- Cost: 1 extra row written per cat create or rename, i.e. a handful per month.
CREATE UNIQUE INDEX cats_slug ON cats (slug) WHERE slug IS NOT NULL AND deleted_at IS NULL;

-- ── sightings ────────────────────────────────────────────────────────────────
CREATE TABLE sightings (
  id              INTEGER PRIMARY KEY,
  client_id       TEXT    NOT NULL,   -- crypto.randomUUID() minted at capture time
  cat_id          INTEGER REFERENCES cats(id),   -- NULL = not identified yet, and that is fine

  lat             REAL    NOT NULL,
  lon             REAL    NOT NULL,
  -- 'exif' | 'device' | 'manual'. Stored so we can reason about pin confidence and debug
  -- the iOS GPS-stripping behaviour. Deliberately NOT displayed — reviewed and cut as
  -- noise next to the street name.
  location_source TEXT    NOT NULL,
  accuracy_m      REAL,               -- null once a pin is hand-placed; a radius around a
                                      -- hand-placed pin is a lie

  seen_at         INTEGER NOT NULL,   -- epoch-ms, from EXIF when present else upload time
  coat            TEXT,               -- sorted comma-joined subset of the 7 chips
  size            TEXT,               -- 'kitten' | 'adult' | 'chonk'
  petted          TEXT,               -- 'yes' | 'no' | 'fled'
  note            TEXT,

  photo_full      TEXT    NOT NULL,   -- sha256 hex of the ~2048px JPEG
  photo_thumb     TEXT    NOT NULL,   -- sha256 hex of the ~480px JPEG
  photo_w         INTEGER NOT NULL,   -- intrinsic px of the full derivative
  photo_h         INTEGER NOT NULL,

  -- Reserved for the AI phase. Written by nothing in v1; present now so that feature is
  -- additive rather than a migration of live data. No index on either — read by id or
  -- scanned, never filtered in SQL.
  embedding       BLOB,
  coat_suggested  TEXT,               -- model output, NEVER written to `coat`, so a model
                                      -- change cannot silently rewrite her own entries

  device_id       TEXT    NOT NULL,   -- client-asserted UUID; a LABEL, not an identity
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  deleted_at      INTEGER
);

-- INDEX 2 of 2, JUSTIFIED.
-- The idempotency key for the offline queue. A retried upload must not create a second
-- sighting, and the insert is ON CONFLICT(client_id) DO NOTHING. Written exactly once at
-- insert and never updated, so it costs 1 row on create and 0 forever after — the only
-- index in this schema that is unambiguously worth it.
CREATE UNIQUE INDEX sightings_client_id ON sightings (client_id);

-- ── app_meta ─────────────────────────────────────────────────────────────────
-- Single row (id = 1). Holds the ETag source and the R2 cost breaker's counters.
--
-- data_version is bumped on every successful mutation and is what GET /sightings compares
-- If-None-Match against, so a warm client's poll costs ONE row read instead of a full
-- table scan. That is the difference between comfortable and constrained at year 5.
--
-- INTEGER PRIMARY KEY rather than a TEXT key/value table on purpose: a TEXT PRIMARY KEY in
-- SQLite is a rowid table plus an implicit unique index, i.e. 2 rows written per bump
-- instead of 1, forever, for nothing.
CREATE TABLE app_meta (
  id            INTEGER PRIMARY KEY,
  data_version  INTEGER NOT NULL,

  -- R2 is the only service in the stack that bills rather than failing closed, and
  -- Cloudflare offers no native spend cap on it, so these counters ARE the control.
  r2_bytes      INTEGER NOT NULL,   -- exact; incremented only when head() says the key is new
  r2_objects    INTEGER NOT NULL,   -- exact, same rule
  r2_reads_est  INTEGER NOT NULL,   -- SAMPLED (1-in-N x N). An exact read counter would cost
                                    -- a D1 write per photo view — blowing the D1 budget to
                                    -- protect the R2 one.
  usage_day     INTEGER NOT NULL,   -- epoch day; uploads_today resets when this rolls
  uploads_today INTEGER NOT NULL,
  reads_month   INTEGER NOT NULL,   -- epoch month index for r2_reads_est
  updated_at    INTEGER NOT NULL
);
INSERT OR IGNORE INTO app_meta
  (id, data_version, r2_bytes, r2_objects, r2_reads_est, usage_day, uploads_today, reads_month, updated_at)
  VALUES (1, 1, 0, 0, 0, 0, 0, 0, 0);

-- ── audit_log ────────────────────────────────────────────────────────────────
-- Written for MUTATING requests only, and only after the request has already cleared the
-- rate limiter AND presented a valid upload pass. That ordering is load-bearing: auditing
-- pre-auth traffic would let one attacker spend the whole 100k/day D1 write budget and
-- take the app offline until midnight UTC.
--
-- Reads are deliberately not audited. They are ~95% of traffic; a cached photo GET never
-- invokes the Worker at all so the data would be silently partial; and everything here is
-- world-public, so knowing someone looked at a cat tells us nothing.
--
-- NEVER exposed over HTTP. Readable only via scripts/db-audit*.
CREATE TABLE audit_log (
  id          INTEGER PRIMARY KEY,
  ts          INTEGER NOT NULL,
  method      TEXT    NOT NULL,
  path        TEXT    NOT NULL,   -- the matched route pattern, not the raw path, so it groups
  status      INTEGER NOT NULL,
  outcome     TEXT    NOT NULL,   -- ok | invalid | notfound | error | pass_issued | pass_denied | budget
  device_id   TEXT,
  pass_sub    TEXT,               -- device_id != pass_sub is the interesting anomaly
  pass_iat    INTEGER,
  ip          TEXT,               -- CF-Connecting-IP; Cloudflare-set, unspoofable
  country     TEXT,
  colo        TEXT,
  asn         INTEGER,            -- OPTIONAL in request.cf — store NULL, never ?? 0
  as_org      TEXT,               -- OPTIONAL. The highest-value field here: "Rogers" vs
                                  -- "DigitalOcean" separates her phone from a scraper instantly
  ray_id      TEXT,               -- CF-Ray; joins to Workers Logs for 3 days
  http_proto  TEXT,
  tls_version TEXT,
  user_agent  TEXT,               -- truncated to 256 chars
  ua_platform TEXT,               -- Sec-CH-UA-Platform; Chromium-only, NULL on Safari
  target_id   INTEGER,
  bytes_in    INTEGER,
  detail      TEXT                -- short free text, e.g. a turnstile error-code
);

-- ═════════════════════════════════════════════════════════════════════════════
-- OMISSION LOG — indexes deliberately NOT created, and why.
--
-- sightings(seen_at) / sightings(created_at)
--   The only reader is GET /sightings, which returns the whole table in one shot for
--   offline support. There is no ORDER BY on the server: rows come back in rowid order
--   (free — it IS the table) and the client sorts. An index here would tax every insert
--   to avoid a sort we never perform.
--
-- sightings(cat_id)
--   "Show me this cat's sightings" is answered CLIENT-SIDE from the bulk payload the
--   client already holds. The server never filters by cat_id.
--
-- sightings(lat, lon) or any spatial index
--   EXPLICITLY EVALUATED AND REJECTED. Viewport queries do not exist in this architecture
--   — the client downloads everything once and pans over local data. Even if they did,
--   a (lat, lon) B-tree cannot answer a bbox query without a full scan of one dimension,
--   and R*Tree is not something to count on in D1. Pure write tax for zero reads. If the
--   dataset ever outgrows the bulk fetch, the answer is a geohash column plus the R2
--   snapshot described in the plan, not this.
--
-- sightings(deleted_at)
--   Nearly every row is NULL, so it has no selectivity for "WHERE deleted_at IS NULL".
--   SQLite would scan the table regardless.
--
-- sightings(photo_full) / sightings(photo_thumb)
--   Would make R2 orphan detection an index seek instead of a table scan. But GC is a
--   manual, offline script run maybe monthly, and a 36k-row scan is 0.7% of one day's
--   read budget. Paying 2 extra writes on EVERY insert forever to speed up a monthly
--   script is exactly the trade this policy forbids.
--
-- audit_log(ts) / audit_log(device_id) / audit_log(ip)
--   ~30 rows/day, ~11k/year, queried by ad-hoc CLI a few times a month. A full scan of
--   11k rows is 0.2% of one day's read budget. Indexing would double or triple the cost
--   of the audit write itself — which rides on the critical path of every upload.
--   Recency uses ORDER BY id DESC, a free reverse rowid walk, and id is monotonic with ts
--   because we never AUTOINCREMENT and never hard-delete inline.
--
-- cats(name)
--   cats_slug already covers lookup and the table has tens of rows.
-- ═════════════════════════════════════════════════════════════════════════════
--
-- WRITE COST PER SIGHTING UPLOAD: 4 rows.
--   1 sightings insert + 1 sightings_client_id index entry + 1 app_meta bump
--   (which carries the data_version AND the R2 counters in the same row) + 1 audit_log.
-- At 20 sightings/day that is 80 rows/day against a 100k/day cap. If you ever measure 5+,
-- an index has snuck in.
