/* Filtering the map by coat.
 *
 * This is what makes the chips worth tapping: tagging a sighting costs a tap at save
 * time and only pays off if "show me the orange ones" works later.
 *
 * MULTI-SELECT IS OR, NOT AND. Two selected chips mean "orange or black", not "an
 * orange-and-black cat". AND reads as the more powerful option but is the wrong default
 * here: coat tags are optional and frequently partial, so an AND of two tags matches
 * almost nothing and looks broken. OR is monotone — every extra chip can only show more
 * — which is a mental model you can hold while walking.
 *
 * The filter is DELIBERATELY NOT PERSISTED. A filter that survives a relaunch means
 * opening the app tomorrow to a map with most of her cats missing and no memory of why.
 */

/** An untagged sighting matches nothing once a filter is on, and everything when off. */
export function matchesCoat(sighting, active) {
  if (active.size === 0) return true;
  const coat = Array.isArray(sighting.coat) ? sighting.coat : [];
  for (const tag of coat) if (active.has(tag)) return true;
  return false;
}

export function filterSightings(sightings, active) {
  if (active.size === 0) return sightings;
  return sightings.filter((s) => matchesCoat(s, active));
}

/**
 * Cats, keeping only their matching sightings, and dropping any cat left with none.
 *
 * Filtering the sightings but NOT the territory is the bug this exists to prevent: a
 * turf blob drawn from hidden points is a shaded zone with nothing inside it.
 */
export function filterCats(cats, active) {
  if (active.size === 0) return cats;
  const out = [];
  for (const cat of cats) {
    const sightings = cat.sightings.filter((s) => matchesCoat(s, active));
    if (sightings.length > 0) out.push({ ...cat, sightings });
  }
  return out;
}

/** Wording for the "you are not seeing everything" strip. */
export function filterSummary(active, shown, total) {
  if (active.size === 0) return null;
  const tags = [...active];
  const names = tags.length === 1
    ? tags[0]
    : `${tags.slice(0, -1).join(', ')} or ${tags.at(-1)}`;
  return `showing ${shown} of ${total} — ${names}`;
}
