-- A deletion journal for R2 objects.
--
-- WHY THIS EXISTS: wrangler has no `r2 object list` (only get/put/delete), so finding
-- orphaned objects otherwise means the REST API and a hand-made token. Requiring a
-- token to clean up your own data is not an acceptable workflow, and it is avoidable:
-- the only way an object becomes unreferenced is that WE unreferenced it, so we can
-- write down the keys before we drop the rows that name them.
--
-- The order is: journal the hashes, delete the rows, delete the objects, clear the
-- journal entries that succeeded. A crash anywhere leaves the hashes recorded, so
-- `npm run gc` can always finish the job with wrangler auth alone. That is exactly the
-- failure that stranded four objects with nothing in D1 naming them.
--
-- OMISSION LOG: no index. This table holds a handful of rows for minutes at a time and
-- is always read with a bare SELECT; an index would be a permanent write tax against the
-- 100k/day cap to speed up a scan of ~0 rows.
CREATE TABLE IF NOT EXISTS r2_gc_queue (
  hash        TEXT PRIMARY KEY,
  queued_at   INTEGER NOT NULL,
  reason      TEXT
);
