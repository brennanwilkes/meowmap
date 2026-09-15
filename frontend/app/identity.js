import { createCat, deleteCat, patchSighting } from './api.js';
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
