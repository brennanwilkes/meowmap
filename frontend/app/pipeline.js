import {
  EXIF_HEAD_BYTES,
  FULL_LONG_EDGE, FULL_MAX_BYTES, FULL_MIN_QUALITY, FULL_START_QUALITY,
  GEO_POOR_ACCURACY_M,
  THUMB_LONG_EDGE, THUMB_MAX_BYTES, THUMB_MIN_QUALITY, THUMB_START_QUALITY,
} from '../config.js';
import { decode, release } from './decode.js';
import { captureTimeMs, readImageMeta } from './exif.js';
import { drawTo, encodeToBudget, releaseCanvas } from './resize.js';

/* picker → exif → decode → resize → SightingDraft.
 *
 * THE ORDER IS FIXED AND NOT NEGOTIABLE: `canvas.toBlob()` emits a bare JFIF JPEG with
 * no APP1 segment, so every re-encode destroys all metadata unconditionally. EXIF must
 * be read from the original bytes, first, always.
 */

/** A photo taken this recently can honestly borrow the phone's current position. */
export const FRESH_PHOTO_WINDOW_MS = 10 * 60_000;

export const LOCATION_SOURCE = { exif: 'exif', device: 'device', manual: 'manual' };

/* ── location resolution (pure) ────────────────────────────────────────── */

/**
 * Decide where the pin goes and how confident we are.
 *
 * NO NAG CARD. The original plan nagged "turn on Options → Location in the picker"
 * whenever a library photo arrived without GPS, on the documented basis that iOS strips
 * it by default. **That did not reproduce** — probe.html on iOS 18.7.5 returned full GPS
 * from a library photo with no picker setting touched. So a missing fix now means a
 * genuinely location-less image (a screenshot, an AirDropped or shared photo, an old
 * import), for which that instruction is not the fix and would simply be wrong. Absent
 * GPS goes straight to tap-the-map. See docs/BUILD-STATUS.md → OPEN DECISION.
 *
 * @param {object} meta          from readImageMeta
 * @param {object|null} deviceFix {lat, lon, accuracyM} or null when it failed
 * @param {boolean} fromCamera    true for the `capture=` path, which has no GPS by design
 */
export function resolveLocation(meta, deviceFix, fromCamera, now) {
  if (meta.gps !== null) {
    return {
      lat: meta.gps.lat,
      lon: meta.gps.lon,
      accuracyM: meta.gps.accuracyM,
      source: LOCATION_SOURCE.exif,
      needsManual: false,
      notice: null,
    };
  }

  if (deviceFix === null) {
    return {
      lat: null,
      lon: null,
      accuracyM: null,
      source: LOCATION_SOURCE.manual,
      needsManual: true,
      notice: fromCamera
        ? 'Your phone could not get a location. Tap the map to place this cat.'
        : 'This photo has no location saved in it. Tap the map to place this cat.',
    };
  }

  // The camera path has GPS stripped by iOS as a matter of course (measured: orientation
  // survives, date and GPS do not), so the device fix is the intended source, not a
  // substitute for a missing one.
  if (fromCamera) {
    return {
      lat: deviceFix.lat,
      lon: deviceFix.lon,
      accuracyM: deviceFix.accuracyM,
      source: LOCATION_SOURCE.device,
      // A bad fix is worse than no fix, because it looks authoritative. Pre-open the
      // correction step rather than quietly accepting it.
      needsManual: deviceFix.accuracyM > GEO_POOR_ACCURACY_M,
      notice: deviceFix.accuracyM > GEO_POOR_ACCURACY_M
        ? `Your location is only accurate to about ${Math.round(deviceFix.accuracyM)} m. Drag the pin if it is off.`
        : null,
    };
  }

  const takenAt = captureTimeMs(meta);
  const fresh = takenAt !== null && Math.abs(now - takenAt) <= FRESH_PHOTO_WINDOW_MS;
  if (fresh) {
    const mins = Math.max(1, Math.round((now - takenAt) / 60_000));
    return {
      lat: deviceFix.lat,
      lon: deviceFix.lon,
      accuracyM: deviceFix.accuracyM,
      source: LOCATION_SOURCE.device,
      needsManual: false,
      // Labelled, never silent: she is being told we guessed, and on what grounds.
      notice: `Using your current location — this photo was taken ${mins} minute${mins === 1 ? '' : 's'} ago.`,
    };
  }

  return {
    lat: null,
    lon: null,
    accuracyM: null,
    source: LOCATION_SOURCE.manual,
    needsManual: true,
    notice: 'This photo has no location saved in it. Tap the map to place this cat.',
  };
}

/** Best capture instant, falling back to now — an upload always has a date. */
export function resolveSeenAt(meta, now) {
  const takenAt = captureTimeMs(meta);
  if (takenAt === null) return now;
  // A clock-skewed camera can claim the future; a photo from 1970 is an unset clock.
  if (takenAt > now + 86_400_000 || takenAt < 946_684_800_000) return now;
  return takenAt;
}

/* ── the pipeline ──────────────────────────────────────────────────────── */

/**
 * Read metadata, decode once, and produce both derivatives.
 *
 * Returns ArrayBuffers rather than Blobs: the outbox holds these for possibly days and
 * iOS's history with Blob backing-file lifetime is bad enough that the opaque handle is
 * not worth the copy it saves.
 */
export async function processPhoto(file) {
  let head = await file.slice(0, EXIF_HEAD_BYTES).arrayBuffer();
  let meta = readImageMeta(head);
  if (meta.truncated) {
    // The walker ran past the slice — an unusually large APP1 or ICC profile. Retry once
    // with the whole file rather than guessing at the missing tags.
    head = await file.arrayBuffer();
    meta = readImageMeta(head);
  }

  const source = await decode(file, meta);
  let fullCanvas = null;
  let thumbCanvas = null;
  try {
    const srcW = source.width;
    const srcH = source.height;

    fullCanvas = drawTo(source, srcW, srcH, FULL_LONG_EDGE);
    const full = await encodeToBudget(fullCanvas, {
      maxBytes: FULL_MAX_BYTES,
      startQuality: FULL_START_QUALITY,
      minQuality: FULL_MIN_QUALITY,
    });

    // From the full canvas, not the original: it guarantees the thumb is a pixel
    // consistent reduction of the image that actually ships.
    thumbCanvas = drawTo(fullCanvas, fullCanvas.width, fullCanvas.height, THUMB_LONG_EDGE);
    const thumb = await encodeToBudget(thumbCanvas, {
      maxBytes: THUMB_MAX_BYTES,
      startQuality: THUMB_START_QUALITY,
      minQuality: THUMB_MIN_QUALITY,
    });

    return {
      meta,
      fullBytes: await full.blob.arrayBuffer(),
      fullW: fullCanvas.width,
      fullH: fullCanvas.height,
      thumbBytes: await thumb.blob.arrayBuffer(),
    };
  } finally {
    release(source);
    if (thumbCanvas !== null) releaseCanvas(thumbCanvas);
    if (fullCanvas !== null) releaseCanvas(fullCanvas);
  }
}
