/* Filtering the map by coat, size, and whether she got to pet them.
 *
 * THE THREE TAGS NO LONGER LIVE IN ONE PLACE. Coat and size are the CAT's (003); petted
 * is the SIGHTING's (004), because it is stamped on the photograph and one answer shared
 * across every photo of a cat would be a lie on all but one of them.
 *
 * So a filter is a question about a cat AND its encounters. A cat matches "petted them"
 * when ANY of its sightings does — which is the question she is actually asking ("which
 * ones have I managed to pet") and a more honest answer than the single cat-level flag
 * that preceded it.
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
 *  `size` is single per cat; `petted` is single per SIGHTING. */
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

function coatMatches(cat, active) {
  if (active.size === 0) return true;          // an untouched group constrains nothing
  const coat = Array.isArray(cat.coat) ? cat.coat : [];
  for (const tag of coat) if (active.has(tag)) return true;
  return false;
}

function oneOf(value, active) {
  if (active.size === 0) return true;
  return value !== null && value !== undefined && active.has(value);
}

/**
 * Does this sighting survive the filter?
 *
 * Coat and size are read off `cat`; petted off the sighting itself.
 *
 * A sighting still queued for upload has NO CAT YET — the Worker mints one when it lands
 * — so until then it carries the coat and size she typed on the capture form, and
 * filtering has to read them from the row. Without that, a pending orange cat vanishes
 * the moment she taps "orange". A catId pointing at no cat means the two halves of the
 * store are briefly out of step; treated as untagged rather than crashing, because this
 * is a render path and it is self-correcting.
 */
export function matches(sighting, cat, f) {
  const described = cat ?? (sighting.catId === null || sighting.catId === undefined
    ? sighting : {});
  return coatMatches(described, f.coat)
    && oneOf(described.size, f.size)
    && oneOf(sighting.petted, f.petted);
}

export function filterSightings(sightings, catsById, f) {
  if (!isActive(f)) return sightings;
  return sightings.filter((s) => matches(s, catsById.get(s.catId) ?? null, f));
}

/**
 * Cats matching the filter, with only the sightings that matched.
 *
 * COAT AND SIZE TAKE THE WHOLE CAT IN OR OUT — there is no such thing as an orange
 * sighting of a grey cat. PETTED DOES NOT: it is per encounter, so the cat stays and the
 * photos where she did not manage it drop out. A cat left with no surviving sighting
 * leaves entirely, which is what keeps a turf blob from being drawn around points that
 * are not on the map — the bug this function exists to avoid.
 */
export function filterCats(cats, f) {
  if (!isActive(f)) return cats;
  return cats
    .filter((cat) => coatMatches(cat, f.coat) && oneOf(cat.size, f.size))
    .map((cat) => ({ ...cat, sightings: cat.sightings.filter((s) => oneOf(s.petted, f.petted)) }))
    .filter((cat) => cat.sightings.length > 0);
}
