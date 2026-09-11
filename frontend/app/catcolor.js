/* A cat's colour is derived from its id and must be identical everywhere it appears —
 * pin ring, turf fill, connector line, list row. That consistency is the whole "these
 * three pins are one cat" mechanism, so it must be a pure function of the id and must
 * never depend on load order, array position or render time.
 *
 * Twelve shades derived from the four sticker hues in tokens.css. Twelve because with
 * only four, a third cat on the same block collides and the map stops being readable;
 * beyond twelve the hues stop being tellable apart at pin size.
 */

export const CAT_PALETTE = [
  { hex: '#ff5470', name: 'coral', dark: true },
  { hex: '#3dbe8b', name: 'jade', dark: false },
  { hex: '#ffc145', name: 'marigold', dark: false },
  { hex: '#7c8cff', name: 'periwinkle', dark: true },
  { hex: '#ff8a5c', name: 'apricot', dark: false },
  { hex: '#4bb8d4', name: 'lagoon', dark: false },
  { hex: '#e46bb0', name: 'fuchsia', dark: true },
  { hex: '#8fbe3d', name: 'moss', dark: false },
  { hex: '#c07cff', name: 'lilac', dark: true },
  { hex: '#ffa8b6', name: 'blossom', dark: false },
  { hex: '#5f9ea0', name: 'teal', dark: false },
  { hex: '#d4a24b', name: 'ochre', dark: false },
];

/* Ids are sequential rowids, so `id % 12` would give consecutive cats ADJACENT hues —
 * and consecutive ids are exactly the cats most likely to have been added in one session
 * on one block. A hash decorrelates order from hue but only makes collisions unlikely
 * (~1 in 12 per adjacent pair, which a test caught happening at ids 37/38).
 *
 * A coprime stride gives the guarantee instead of the probability. gcd(5, 12) = 1, so
 * multiplying by 5 walks 0,5,10,3,8,1,6,11,4,9,2,7 — every shade used exactly once per
 * cycle, consecutive ids always 5 or 7 apart in the palette, and never equal. Perfectly
 * even distribution falls out for free. */
const STRIDE = 5;

/** IDs can legitimately be 0, so this checks for null, never falsiness. */
export function catColour(id) {
  if (id === null || id === undefined) return null;
  const n = Math.abs(Math.trunc(id));
  return CAT_PALETTE[(n * STRIDE) % CAT_PALETTE.length];
}

/** The ring/fill colour for a sighting: its cat's colour, or paper for an unidentified
 *  one. Unidentified pins are drawn dashed and desaturated by CSS, not by this. */
export function ringFor(catId) {
  const c = catColour(catId);
  return c === null ? 'var(--paper-hi)' : c.hex;
}

/** Text colour that stays legible on that fill. */
export function inkFor(catId) {
  const c = catColour(catId);
  return c !== null && c.dark ? '#ffffff' : 'var(--ink)';
}

/* Unnamed cats are a permanent, first-class state — most sightings will live there and
 * that is the design working. The photo does the identifying, so the label only has to
 * be honest and stable. It deliberately does NOT invent a trait ("the shy one") or a
 * place we have not geocoded. */
export function displayName(cat) {
  if (cat === null || cat === undefined) return 'Not named yet';
  if (typeof cat.name === 'string' && cat.name.trim() !== '') return cat.name.trim();
  return 'Not named yet';
}

/** Short stable tag, only for disambiguating several unnamed cats in one list. */
export function shortTag(id) {
  if (id === null || id === undefined) return '';
  const c = catColour(id);
  return c.name;
}
