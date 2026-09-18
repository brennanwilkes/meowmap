/* "Mochi's turf" — the territory blob drawn around a cat's sightings.
 *
 * Replaces connector lines, which turn to spaghetti past four or five points. TWO OR MORE
 * sightings earns a blob. It was three, with two drawing a dashed connector instead —
 * but a second sighting is the exact moment a cat stops being a dot and starts having a
 * patch it lives on, which is the whole point of the map, and holding that back until the
 * third made the app look like it had not noticed. The support function of two points is
 * a stadium, which is a perfectly good territory.
 *
 * Shape: the SUPPORT FUNCTION of the points sampled at fixed angles, padded outward,
 * with a deterministic wobble. Chosen over a convex hull with rounded corners because it
 * is always smooth, always convex, and can never self-intersect — a hull of three nearly
 * collinear sightings degenerates into a sliver, which looked like a bug on the map.
 *
 * The wobble is deterministic (sine of the angle, not random) so the blob does not
 * shimmer between renders, which it did when seeded from Math.random.
 */

export const TURF_MIN_SIGHTINGS = 2;
export const TURF_PAD_M = 70;
/** Only once you are genuinely zoomed in. At 14 the blob is small and the label just
 *  collides with its neighbours. */
export const TURF_MIN_ZOOM = 16;

const STEPS = 44;

/**
 * @param pts  [[lat, lon], …] — at least one
 * @returns { ring: [[lat, lon], …], centre: [lat, lon] }
 */
export function turfRing(pts, padM = TURF_PAD_M) {
  if (!Array.isArray(pts) || pts.length === 0) {
    throw new Error('turfRing needs at least one point');
  }

  const latRef = pts.reduce((s, p) => s + p[0], 0) / pts.length;
  const lonRef = pts.reduce((s, p) => s + p[1], 0) / pts.length;
  const mLat = 111_320;
  const mLon = 111_320 * Math.cos((latRef * Math.PI) / 180);
  // Guard the poles rather than dividing by ~0 later. Nobody is photographing cats at
  // 89.999°N, but a silent Infinity would render as an empty map with no error.
  if (!Number.isFinite(mLon) || Math.abs(mLon) < 1e-6) {
    throw new Error('turfRing: degenerate longitude scale near the pole');
  }

  const xy = pts.map((p) => [(p[1] - lonRef) * mLon, (p[0] - latRef) * mLat]);

  const ring = [];
  for (let i = 0; i < STEPS; i++) {
    const th = (i / STEPS) * 2 * Math.PI;
    const ux = Math.cos(th);
    const uy = Math.sin(th);
    let r = -Infinity;
    for (const [x, y] of xy) {
      const d = x * ux + y * uy;
      if (d > r) r = d;
    }
    r = (r + padM) * (1 + 0.05 * Math.sin(th * 3 + 1.2) + 0.03 * Math.sin(th * 5 + 0.4));
    ring.push([latRef + (r * uy) / mLat, lonRef + (r * ux) / mLon]);
  }
  return { ring, centre: [latRef, lonRef] };
}

export function shouldDrawTurf(sightingCount) {
  return sightingCount >= TURF_MIN_SIGHTINGS;
}
