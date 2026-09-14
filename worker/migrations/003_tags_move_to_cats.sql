-- Coat, size and petted describe the ANIMAL, not the encounter, so they move from
-- sightings to cats.
--
-- The old shape let one cat be an orange tabby in June and a grey chonk in July, with
-- nothing in the UI to reconcile them and no answer to "what colour is this cat" once
-- several sightings disagreed. Every sighting has belonged to a cat since 002, so the
-- cat is now the only place these live.
--
-- 'petted' moves too. It is arguably per-encounter -- she might pet today a cat that
-- fled last week -- and that was raised and decided: it reads as "have I ever managed to
-- pet this one", which is the question actually being asked.
--
-- NO NEW INDEXES. All three are read as part of a cat row that is already being fetched,
-- and filtering happens client-side over the full set the app downloads anyway. An index
-- here would be a write tax on every rename for nothing.

ALTER TABLE cats ADD COLUMN coat   TEXT;   -- sorted comma-joined subset of the 7 chips
ALTER TABLE cats ADD COLUMN size   TEXT;   -- 'kitten' | 'adult' | 'chonk'
ALTER TABLE cats ADD COLUMN petted TEXT;   -- 'yes' | 'no'

-- FIRST: any sighting still without a cat gets one, carrying its tags straight across.
--
-- Migration 002 made the Worker mint a cat for every new upload but did not go back for
-- rows already in the table, so pre-002 sightings still have cat_id NULL -- and their
-- tags would be dropped on the floor by the backfill below, which can only reach a cat
-- through cat_id. Found in the live data: sighting 1 (orange / kitten / petted).
--
-- The 'migrate:<id>' marker in notes is how a row-by-row link is done in plain SQL: an
-- INSERT...SELECT cannot report which new id belongs to which source row. It is written,
-- read back, and cleared within this migration and never observed by the app.
INSERT INTO cats (name, slug, notes, coat, size, petted, created_at, updated_at)
SELECT NULL, NULL, 'migrate:' || s.id, s.coat, s.size, s.petted, s.created_at, s.created_at
  FROM sightings s
 WHERE s.cat_id IS NULL AND s.deleted_at IS NULL;

UPDATE sightings SET cat_id = (
  SELECT c.id FROM cats c WHERE c.notes = 'migrate:' || sightings.id
) WHERE cat_id IS NULL AND deleted_at IS NULL;

UPDATE cats SET notes = NULL WHERE notes LIKE 'migrate:%';

-- Backfill the rest: most recent sighting that actually carried a value wins.
--
-- Note this is NOT the union rule the app applies when merging two cats from now on.
-- Unioning comma-joined sets in SQLite needs a recursive split and a re-sort, which is a
-- lot of machinery for a one-time pass over a handful of test rows. Most-recent is the
-- honest approximation here; the union rule lives in the app where merges happen.
UPDATE cats SET
  coat = (SELECT s.coat FROM sightings s
           WHERE s.cat_id = cats.id AND s.deleted_at IS NULL
             AND s.coat IS NOT NULL AND s.coat <> ''
           ORDER BY s.seen_at DESC LIMIT 1),
  size = (SELECT s.size FROM sightings s
           WHERE s.cat_id = cats.id AND s.deleted_at IS NULL AND s.size IS NOT NULL
           ORDER BY s.seen_at DESC LIMIT 1),
  petted = (SELECT s.petted FROM sightings s
             WHERE s.cat_id = cats.id AND s.deleted_at IS NULL AND s.petted IS NOT NULL
             ORDER BY s.seen_at DESC LIMIT 1);

-- 'fled' was removed from the vocabulary earlier; anything left over is not 'yes'.
UPDATE cats SET petted = 'no' WHERE petted IS NOT NULL AND petted NOT IN ('yes', 'no');

-- Drop them from sightings rather than leaving both. Two places to write one fact is the
-- bug factory this codebase keeps refusing elsewhere, and a stale copy would silently win
-- whichever read path was written second.
ALTER TABLE sightings DROP COLUMN coat;
ALTER TABLE sightings DROP COLUMN size;
ALTER TABLE sightings DROP COLUMN petted;
