import {
  PASS_IMAGE_ORIENTATION, RESIZE_ON_DECODE_LONG_EDGE, SOURCE_PIXEL_CEILING,
} from '../config.js';

/* File → ImageBitmap, with the two iOS traps guarded.
 *
 * ORIENTATION: do NOT pass `imageOrientation` and do NOT rotate afterwards. Measured on
 * iPhone 18.7.5 (probe.html): the option is IGNORED (honoursOrientationOption: false)
 * while EXIF orientation is auto-applied anyway — a 4032x3024 photo tagged orientation 6
 * decodes as 3024x4032. Rotating on top of that produces sideways cats. The constant
 * exists so the decision is visible at the call site rather than implied by absence.
 *
 * SOURCE SIZE: above w*h > 16,777,216 iOS yields a blank canvas with no exception. The
 * destination is never the problem (2048x1536 = 3.1 MP); the source is — a 48 MP still is
 * 195 MB of RGBA. Above SOURCE_PIXEL_CEILING we ask the decoder to downscale during
 * decode so the full bitmap is never materialised.
 */

export class DecodeError extends Error {
  constructor(message, cause = null) {
    super(message);
    this.name = 'DecodeError';
    this.cause = cause;
  }
}

/**
 * @param {File|Blob} file
 * @param {{pixelWidth: number|null, pixelHeight: number|null}} meta — SOFn dimensions from
 *   exif.js, read from the original bytes *before* this call. Null when the header could
 *   not be parsed (PNG, or a truncated slice), in which case no ceiling can be applied.
 */
export async function decode(file, meta) {
  const sourcePixels = meta.pixelWidth !== null && meta.pixelHeight !== null
    ? meta.pixelWidth * meta.pixelHeight
    : null;
  const huge = sourcePixels !== null && sourcePixels > SOURCE_PIXEL_CEILING;

  if (typeof createImageBitmap === 'function') {
    const opts = {};
    if (PASS_IMAGE_ORIENTATION) opts.imageOrientation = 'from-image';

    if (huge) {
      const long = Math.max(meta.pixelWidth, meta.pixelHeight);
      const scale = RESIZE_ON_DECODE_LONG_EDGE / long;
      opts.resizeWidth = Math.round(meta.pixelWidth * scale);
      opts.resizeHeight = Math.round(meta.pixelHeight * scale);
      opts.resizeQuality = 'high';
    }

    let bmp;
    try {
      bmp = await createImageBitmap(file, opts);
    } catch (err) {
      throw new DecodeError(containerAdvice(meta), err);
    }

    // A silently-ignored resizeWidth means we just materialised the full bitmap on a
    // device that cannot afford it — a hard error here, not a quiet full decode. The
    // tolerance absorbs the decoder's own rounding, nothing more.
    if (huge && Math.abs(bmp.width - opts.resizeWidth) > 2) {
      bmp.close();
      throw new DecodeError(
        `This photo is too large for your phone to process (${(sourcePixels / 1e6).toFixed(0)} MP).`,
      );
    }
    return bmp;
  }

  // No createImageBitmap. Nothing can be done about a huge source here — the full bitmap
  // is materialised by definition — so refuse rather than hand back a blank canvas.
  if (huge) {
    throw new DecodeError(
      `This photo is too large for your phone to process (${(sourcePixels / 1e6).toFixed(0)} MP).`,
    );
  }

  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    // decode(), not onload: it surfaces a decode failure as a rejection instead of
    // firing successfully on a broken image.
    await img.decode().catch((err) => { throw new DecodeError(containerAdvice(meta), err); });
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** A decode failure on HEIF has one specific fix, and naming it is the whole point. */
function containerAdvice(meta) {
  if (meta.container === 'heif') {
    return 'Your phone could not read this HEIC photo. In the photo picker, tap Options '
      + "and set Format to 'Most Compatible', then try again.";
  }
  return 'That image could not be opened.';
}

/** ImageBitmap needs closing; HTMLImageElement does not. One call site either way. */
export function release(source) {
  if (typeof ImageBitmap !== 'undefined' && source instanceof ImageBitmap) source.close();
}
