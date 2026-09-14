/* Filtering the map by the tags a CAT carries: coat, size, and whether she got to pet it.
 *
 * These moved from the sighting to the cat in migration 003 — they describe the animal,
 * not the encounter — so a filter is really a question about cats, and the sightings that
 * survive it are the ones belonging to a cat that matched.
 *
 * This is what makes the chips worth tapping. Tagging costs a tap at save time and only
 * pays off if "show me the orange ones" works later.
 *
 * SEMANTICS: OR within a group, AND across groups.
 *   orange + black          → orange or black cats
 *   orange + chonk          → orange cats that are also chonks
 * That is the conventional facet model and it is the one people already expect from
 * every shop and photo library. Within a group, OR keeps each extra chip monotone —
 * it can only reveal more — which is a model you can hold while walking. Across groups,
 * AND is what makes a second group worth having at all: coat AND size that both had to
 * match is the only way to narrow anything.
 *
 * An untagged sighting is hidden by any active group, and shown when none is active.
 * It has to be: "show me the orange ones" cannot honestly include unknowns.
 *
 * The filter is DELIBERATELY NOT PERSISTED. A filter that survives a relaunch means
 * opening the app tomorrow to a map with most of her cats missing and no memory of why.
 *
 * There is also deliberately NO "showing 3 of 9" banner. It was tried on the phone and
 * cut: the chips are already lit, so the banner restated what the controls showed while
 * covering the map it was describing.
 */

/** The groups, in the order they appear on the strip. `coat` is multi-valued per cat;
 *  `size` and `petted` are single. */
export const FILTER_GROUPS = ['coat', 'size', 'petted'];

export function emptyFilter() {
  return { coat: new Set(), size: new Set(), petted: new Set() };
}

export function isActive(f) {
  return FILTER_GROUPS.some((g) => f[g].size > 0);
}

export function toggle(f, group, value) {
  if (f[group].has(value)) f[group].delete(value); else f[group].add(value);
  return f;
}

function groupMatches(tagged, group, active) {
  if (active.size === 0) return true;          // an untouched group constrains nothing
  if (group === 'coat') {
    const coat = Array.isArray(tagged.coat) ? tagged.coat : [];
    for (const tag of coat) if (active.has(tag)) return true;
    return false;
  }
  const v = tagged[group];
  return v !== null && v !== undefined && active.has(v);
}

/** `tagged` is a cat, or a pending sighting still carrying its own tags. */
export function matches(tagged, f) {
  return FILTER_GROUPS.every((g) => groupMatches(tagged, g, f[g]));
}

/**
 * Where a sighting's tags actually live.
 *
 * Normally on its cat. A sighting still queued for upload has no cat yet — the Worker
 * mints one when it lands — so until then it carries the tags she typed on the capture
 * form, and filtering has to read them from the row itself or a pending orange cat
 * vanishes the moment she taps "orange".
 *
 * A cat id pointing at no cat means the two halves of the store are briefly out of step.
 * Treated as untagged rather than crashing the map: it is transient and self-correcting,
 * and this is a render path.
 */
export function tagsFor(sighting, catsById) {
  if (sighting.catId === null || sighting.catId === undefined) return sighting;
  const cat = catsById.get(sighting.catId);
  return cat === undefined ? {} : cat;
}

export function filterSightings(sightings, catsById, f) {
  if (!isActive(f)) return sightings;
  return sightings.filter((s) => matches(tagsFor(s, catsById), f));
}

/**
 * Cats matching the filter, with every one of their sightings.
 *
 * Whole cats in or out, because the tags belong to the cat: there is no longer such a
 * thing as an orange sighting of a grey cat. That also removes the bug the old
 * per-sighting version existed to avoid — a turf blob drawn around points that were
 * themselves filtered out.
 */
export function filterCats(cats, f) {
  if (!isActive(f)) return cats;
  return cats.filter((cat) => matches(cat, f));
}
