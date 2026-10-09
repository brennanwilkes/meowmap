-- Two cats may share a name.
--
-- 001 made `cats_slug` UNIQUE on the reasoning that two live cats named "Mochi" would fork
-- one cat's history. Since then a cat's identity has become its id: every upload mints
-- one, grouping is a merge of ids, and nothing reads `slug` at all. The constraint was
-- only ever able to fail:
--
--   - A merge renames the surviving (older) cat to the absorbed one's name WHILE the
--     absorbed cat still holds it, so joining an unnamed cat to a named one always 500'd.
--     That is how it was found: ten failed PATCH /cats/14 on 2026-10-09.
--   - A new upload named like an existing cat (a second "Baby" on another street) 500'd on
--     the cat insert, and the outbox retries a 500 forever — her photo stuck for good.
--
-- The column goes with the index; nothing reads it, and keeping it would be a second copy
-- of `name` to drift. Not in the /sightings payload, so data_version is untouched.

DROP INDEX cats_slug;
ALTER TABLE cats DROP COLUMN slug;
