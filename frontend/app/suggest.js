/* "Is this Mochi?" — ranking candidate cats for a newly saved sighting.
 *
 * One pure function over plain objects, so it is directly unit-testable and so the later
 * visual-similarity term is one more weighted input rather than a rewrite.
 *
 * The algorithm's only job is to put the right three FACES in front of her. She does the
 * identifying by looking at the photo; this just has to not waste the three slots. That
 * is why it is deliberately simple and why a weak signal must demote rather than exclude.
 */

/* A cat several blocks away is a different cat — but 250 m was drawing the line inside
 * one cat's actual range. They wander a block or two, she photographs them from wherever
 * she happens to be standing, and the pin carries 10-20 m of GPS error on top; the common
 * miss was the same cat on the far corner of the same park. Missing a suggestion costs
 * her the whole grouping flow, while an extra face in a row of three costs a glance. */
export const MAX_DISTANCE_M = 450;
export const MAX_SUGGESTIONS = 3;

const DAY_MS = 86_400_000;

/** Metres between two lat/lon points. Equirectangular rather than haversine: at the
 *  sub-kilometre distances this is used for, the error is far below GPS accuracy and it
 *  costs a third as much. */
export function distanceM(aLat, aLon, bLat, bLon) {
  const mPerLat = 111_320;
  const mPerLon = 111_320 * Math.cos(((aLat + bLat) / 2) * Math.PI / 180);
  const dx = (aLon - bLon) * mPerLon;
  const dy = (aLat - bLat) * mPerLat;
  return Math.sqrt(dx * dx + dy * dy);
}

/** Jaccard overlap of two coat-tag lists, or null when either side has no tags.
 *  Null is distinct from 0: "no information" must not be scored like "definitely
 *  different", because tags are optional and usually absent. */
export function coatOverlap(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || b.length === 0) return null;
  const setB = new Set(b);
  let shared = 0;
  for (const t of new Set(a)) if (setB.has(t)) shared++;
  const union = new Set([...a, ...b]).size;
  return union === 0 ? null : shared / union;
}

/**
 * Score one candidate cat. Higher is better; null means "not a candidate".
 *
 * Weighting, in order of trust:
 *   distance  — strongest. A cat seen at this exact spot last week beats one 200 m
 *               away yesterday, which is why recency is deliberately weak.
 *   coat      — moderate, and only when BOTH sides have tags. A mismatch demotes hard
 *               (an orange tabby is not the black one from this fence) but never
 *               excludes, because she may simply not have tagged it.
 *   recency   — weak tiebreak only. Cats live somewhere for years.
 */
export function scoreCandidate(sighting, cat, now) {
  if (cat.sightings.length === 0) return null;

  let nearestM = Infinity;
  let newestAt = -Infinity;
  for (const s of cat.sightings) {
    const d = distanceM(sighting.lat, sighting.lon, s.lat, s.lon);
    if (d < nearestM) nearestM = d;
    if (s.seenAt > newestAt) newestAt = s.seenAt;
  }
  if (nearestM > MAX_DISTANCE_M) return null;

  // 1 at zero metres, 0 at the cutoff.
  const proximity = 1 - nearestM / MAX_DISTANCE_M;

  /* The candidate's coat comes from the CAT, not from its nearest sighting — tags
   * describe the animal since migration 003. `sighting.coat` is still the draft's own,
   * because a photo being saved has no cat yet. */
  const overlap = coatOverlap(sighting.coat, cat.coat);
  // Absent tags score neutral (0.5), so an untagged sighting is neither rewarded nor
  // punished relative to a tagged one.
  const coatScore = overlap === null ? 0.5 : overlap;

  const ageDays = Math.max(0, (now - newestAt) / DAY_MS);
  const recency = 1 / (1 + ageDays / 30);   // half-weight at a month old

  const score = proximity * 0.6 + coatScore * 0.3 + recency * 0.1;
  return { catId: cat.id, score, nearestM, lastSeenAt: newestAt, coatOverlap: overlap };
}

/**
 * @param sighting  { lat, lon, coat }  — the draft being saved, carrying its own tags
 * @param cats      [{ id, coat, sightings: [{ lat, lon, seenAt }] }]
 * @returns at most MAX_SUGGESTIONS, best first
 */
export function suggestCats(sighting, cats, now) {
  const scored = [];
  for (const cat of cats) {
    const s = scoreCandidate(sighting, cat, now);
    if (s !== null) scored.push(s);
  }
  // Deterministic: ties break on the nearer cat, then the lower id, so the same input
  // always yields the same three faces in the same order.
  scored.sort((a, b) =>
    b.score - a.score || a.nearestM - b.nearestM || a.catId - b.catId);
  return scored.slice(0, MAX_SUGGESTIONS);
}

/** Human reason shown under the candidate's name. Kept short — the photo is the
 *  argument, this is just the footnote. */
export function reasonText(s, now) {
  const m = Math.round(s.nearestM);
  const where = m < 10 ? 'right here' : `${m} metres away`;
  const days = Math.floor((now - s.lastSeenAt) / DAY_MS);
  let when;
  if (days <= 0) when = 'earlier today';
  else if (days === 1) when = 'yesterday';
  else if (days < 14) when = `${days} days ago`;
  else if (days < 60) when = 'last month';
  else when = `${Math.round(days / 30)} months ago`;
  return `${where}, ${when}`;
}
