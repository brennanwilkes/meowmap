/* Filtering the map by the tags a sighting carries: coat, size, and whether she got to
 * pet it.
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

/** The groups, in the order they appear on the strip. `coat` is multi-valued per
 *  sighting; `size` and `petted` are single. */
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

function groupMatches(sighting, group, active) {
  if (active.size === 0) return true;          // an untouched group constrains nothing
  if (group === 'coat') {
    const coat = Array.isArray(sighting.coat) ? sighting.coat : [];
    for (const tag of coat) if (active.has(tag)) return true;
    return false;
  }
  const v = sighting[group];
  return v !== null && v !== undefined && active.has(v);
}

export function matches(sighting, f) {
  return FILTER_GROUPS.every((g) => groupMatches(sighting, g, f[g]));
}

export function filterSightings(sightings, f) {
  if (!isActive(f)) return sightings;
  return sightings.filter((s) => matches(s, f));
}

/**
 * Cats, keeping only their matching sightings, and dropping any cat left with none.
 *
 * Filtering the sightings but NOT the territory is the bug this exists to prevent: a
 * turf blob computed from points that are not drawn is a shaded zone with nothing
 * inside it.
 */
export function filterCats(cats, f) {
  if (!isActive(f)) return cats;
  const out = [];
  for (const cat of cats) {
    const sightings = cat.sightings.filter((s) => matches(s, f));
    if (sightings.length > 0) out.push({ ...cat, sightings });
  }
  return out;
}
