import { createCat, deleteCat, patchCat, patchSighting } from './api.js';
import * as store from './store.js';

/* Who a photo is of. Both pages that can change it share this, so the two can never
 * disagree about what "a different cat" does.
 *
 * MULTI-STEP AND DELIBERATELY NOT ATOMIC. It is POST /cats + PATCH + maybe DELETE, and a
 * failure part-way must fail VISIBLY rather than roll back: unlinking before deleting
 * leaves loose data rather than dangling references, which is the recoverable direction.
 */

/**
 * Take one sighting out of a cat and give it a cat of its own.
 *
 * The exact inverse of "I've seen this cat before", so every join is undoable by a single
 * tap and nothing can be left half-done.
 */
export async function splitToNewCat(sightingId, cat) {
  /* The new cat inherits the description it is leaving. She grouped these because they
   * looked alike, so an orange tabby splitting off is still an orange tabby — starting it
   * blank would make her re-type what she already knows. */
  const { cat: fresh } = await createCat({ coat: cat.coat, size: cat.size });
  await patchSighting(sightingId, { catId: fresh.id });
  // The cat this left may now be empty; tidy it rather than leaving a shell that renders
  // as a grey box captioned "seen 0 times".
  if (cat.sightings.length === 1) await deleteCat(cat.id);
  await store.refresh();
  return fresh;
}


/** Newest sighting, or -Infinity for a cat with none. */
function newestAt(cat) {
  return cat.sightings.reduce((a, s) => Math.max(a, s.seenAt), -Infinity);
}

/**
 * Two cats become one, and their descriptions have to become one too.
 *
 * COAT UNIONS; size takes the more recently seen cat's answer. A union loses nothing — a
 * cat tagged "orange" here and "tabby" there is an orange tabby, and discarding half
 * would quietly delete something she typed. Size cannot union (a cat is not both a kitten
 * and a chonk), so the newer observation wins as the more likely to still be true; the
 * older one is kept only where the newer has no answer.
 *
 * Petted needs no rule at all any more: it lives on each sighting, so merging two cats
 * simply carries every photo's own answer across with it. That is the clearest argument
 * that 004 put it in the right place.
 */
export function mergeTags(survivor, absorbed) {
  const [newer, older] = newestAt(survivor) >= newestAt(absorbed)
    ? [survivor, absorbed] : [absorbed, survivor];
  return {
    coat: [...new Set([...survivor.coat, ...absorbed.coat])].sort(),
    size: newer.size ?? older.size,
    // Whichever way round she taps, the cat she met first keeps its name.
    name: survivor.name ?? absorbed.name,
  };
}

/**
 * Fold two cats into one and return the id of the survivor.
 *
 * THE OLDER CAT ALWAYS SURVIVES, whichever way round she taps, so the one she met first
 * keeps its name and its colour. The exact inverse of splitToNewCat, which is what makes
 * every join undoable by a single tap.
 */
export async function mergeCats(catId, otherId) {
  const survivorId = Math.min(catId, otherId);
  const absorbedId = Math.max(catId, otherId);
  const all = store.catsWithSightings();
  const keeper = all.find((c) => c.id === survivorId);
  const doomed = all.find((c) => c.id === absorbedId);
  if (keeper === undefined || doomed === undefined) {
    throw new Error('one of those cats is no longer here');
  }
  await patchCat(survivorId, mergeTags(keeper, doomed));
  for (const s of doomed.sightings) {
    // eslint-disable-next-line no-await-in-loop -- serial on purpose; see the header
    await patchSighting(s.id, { catId: survivorId });
  }
  await deleteCat(absorbedId);
  await store.refresh();
  return survivorId;
}
