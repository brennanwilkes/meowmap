-- Petted belongs to the SIGHTING, not the cat.
--
-- 003 moved coat, size and petted onto `cats` together, on the reasoning that all three
-- describe the animal and that petted reads as "have I ever managed to pet this one".
-- That was raised and decided then, and it is being reversed now for a concrete reason:
-- petted is DRAWN ON THE PHOTOGRAPH. Once the polaroid itself carries the mark, a fact
-- shared across every photo of the cat is a lie on all but one of them — the day she
-- finally got to pet him does not retroactively make the photo from March a petting.
--
-- Coat and size stay on the cat. Those genuinely cannot differ between encounters
-- without one of them being wrong; whether she got to touch the cat genuinely can.
--
-- Filtering still works the way she means it: a cat matches "petted" when ANY of its
-- sightings is petted, which is the same question as before and a more honest answer.

ALTER TABLE sightings ADD COLUMN petted TEXT;

-- Every sighting inherits its cat's answer, which is the best available: it was itself
-- derived from the sightings in 003, and nothing since has had anywhere else to put it.
UPDATE sightings
   SET petted = (SELECT c.petted FROM cats c WHERE c.id = sightings.cat_id)
 WHERE cat_id IS NOT NULL;

-- Two places to write one fact is the bug factory this codebase refuses everywhere else,
-- so the old column goes rather than being left to drift.
ALTER TABLE cats DROP COLUMN petted;

-- 003 did NOT do this and every client held a stale ETag: /sightings answered 304, the
-- app kept the old shape, and the first page to read the new one crashed. A migration
-- that changes the payload MUST bump the version that gates it.
UPDATE app_meta SET data_version = data_version + 1, updated_at = 0 WHERE id = 1;
