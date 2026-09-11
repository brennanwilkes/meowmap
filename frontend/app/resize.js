import { ASSERT_ENCODED_MIME, QUALITY_SEARCH_STEPS } from '../config.js';

/* Downscale and encode. Two derivatives come out of one decode: the 2048px full, and the
 * 480px thumb generated FROM the full canvas rather than from the original — three cheap
 * draws on small surfaces, and it guarantees the thumb is a pixel-consistent reduction of
 * the image that actually ships.
 *
 * JPEG ONLY. `canvas.toBlob('image/webp')` returned image/png on the target device
 * (measured, probe.html) with no error — and a 2048px PNG is ~5 MB. ASSERT_ENCODED_MIME
 * turns that silent substitution into a throw.
 */

export class EncodeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'EncodeError';
  }
}

/* ── pure geometry ─────────────────────────────────────────────────────── */

/** Never upscales: a 300px photo stays 300px rather than being blown up to 2048. */
export function fitLongEdge(w, h, longEdge) {
  const scale = Math.min(1, longEdge / Math.max(w, h));
  return { w: Math.max(1, Math.round(w * scale)), h: Math.max(1, Math.round(h * scale)) };
}

/**
 * Sizes to draw through on the way down. Safari's default canvas scaler is low quality
 * and a single 6x reduction visibly aliases fur, so halve while the remaining factor
 * exceeds 2 and take the remainder in one final step.
 */
export function halvingPlan(fromW, fromH, toW, toH) {
  const steps = [];
  let w = fromW;
  let h = fromH;
  while (w / 2 > toW && h / 2 > toH) {
    w = Math.max(1, Math.round(w / 2));
    h = Math.max(1, Math.round(h / 2));
    steps.push({ w, h });
  }
  steps.push({ w: toW, h: toH });
  return steps;
}

/* ── canvas ────────────────────────────────────────────────────────────── */

function canvasOf(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  // alpha: false so a transparent PNG composites onto white rather than onto black,
  // which is what JPEG encoding of an alpha canvas otherwise produces.
  const ctx = c.getContext('2d', { alpha: false });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);
  return { c, ctx };
}

/** Safari retains the backing store past GC, so shrinking to 1x1 is the actual free. */
export function releaseCanvas(c) {
  const ctx = c.getContext('2d');
  if (ctx !== null) ctx.clearRect(0, 0, c.width, c.height);
  c.width = 1;
  c.height = 1;
}

/** Draw `source` down to `longEdge`, returning a canvas the caller must release. */
export function drawTo(source, srcW, srcH, longEdge) {
  const target = fitLongEdge(srcW, srcH, longEdge);
  const plan = halvingPlan(srcW, srcH, target.w, target.h);

  let current = source;
  let currentW = srcW;
  let currentH = srcH;
  let scratch = null;

  for (const step of plan) {
    const { c, ctx } = canvasOf(step.w, step.h);
    ctx.drawImage(current, 0, 0, currentW, currentH, 0, 0, step.w, step.h);
    if (scratch !== null) releaseCanvas(scratch);
    scratch = c;
    current = c;
    currentW = step.w;
    currentH = step.h;
  }
  return scratch;
}

function toBlob(canvas, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob === null) { reject(new EncodeError('The image could not be encoded.')); return; }
      if (ASSERT_ENCODED_MIME && blob.type !== 'image/jpeg') {
        reject(new EncodeError(`Encoder produced ${blob.type} instead of JPEG.`));
        return;
      }
      resolve(blob);
    }, 'image/jpeg', quality);
  });
}

/**
 * Hit a byte budget by bounded bisection rather than a fixed quality — a cat in a bush
 * and a cat asleep on a step compress an order of magnitude apart, so one hardcoded
 * quality either wastes bytes or wrecks the busy photo.
 *
 * Over budget at minQuality throws. Uploading a 3 MB "thumbnail" is worse than failing.
 */
export async function encodeToBudget(canvas, { maxBytes, startQuality, minQuality }) {
  let blob = await toBlob(canvas, startQuality);
  if (blob.size <= maxBytes) return { blob, quality: startQuality };

  let lo = minQuality;
  let hi = startQuality;
  let best = null;

  for (let i = 0; i < QUALITY_SEARCH_STEPS; i++) {
    const q = (lo + hi) / 2;
    // eslint-disable-next-line no-await-in-loop -- the search is inherently sequential
    blob = await toBlob(canvas, q);
    if (blob.size <= maxBytes) { best = { blob, quality: q }; lo = q; } else { hi = q; }
    // Bisecting upward from a passing quality only wastes encodes once we are close.
    if (best !== null && hi - lo < 0.05) break;
  }

  if (best === null) {
    const floor = await toBlob(canvas, minQuality);
    if (floor.size > maxBytes) {
      throw new EncodeError(
        `This photo will not compress small enough (${Math.round(floor.size / 1024)} KB).`,
      );
    }
    return { blob: floor, quality: minQuality };
  }
  return best;
}
