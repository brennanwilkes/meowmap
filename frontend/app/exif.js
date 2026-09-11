/* Minimal EXIF reader — GPS, capture time, orientation, and the source dimensions.
 *
 * THE ORDERING CONSTRAINT THAT GOVERNS THE WHOLE PIPELINE:
 * canvas.toBlob() emits a bare JFIF JPEG with no APP1 segment, so every canvas re-encode
 * destroys all metadata, unconditionally, in every browser. This must therefore run on
 * the ORIGINAL bytes, before any decode or resize. Metadata can never be recovered from
 * a resized blob.
 *
 * Everything here throws on malformed input rather than returning a plausible default.
 * A silently-wrong coordinate is a pin on the wrong street that nobody ever notices.
 *
 * Scope is deliberately JPEG-only. HEIF stores EXIF in a meta/iinf/iloc box rather than
 * an APP1 segment — a separate ~150-line walker — and is not worth writing while iOS
 * strips GPS from library photos by default anyway. HEIF is detected and reported.
 */

export class ExifError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ExifError';
  }
}

/* ── container sniffing ────────────────────────────────────────────────────
 * Sniff bytes; never trust file.type or the extension. iOS hands back
 * inconsistent MIME types depending on the picker's Format setting. */

const HEIF_BRANDS = new Set([
  'heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs', 'mif1', 'msf1',
]);

export function sniffContainer(buf) {
  const b = new Uint8Array(buf);
  if (b.length < 16) return 'unknown';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png';
  // ISOBMFF: size(4) 'ftyp' major_brand(4)
  if (b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) {
    const brand = String.fromCharCode(b[8], b[9], b[10], b[11]).toLowerCase();
    if (HEIF_BRANDS.has(brand)) return 'heif';
  }
  return 'unknown';
}

/* ── TIFF/EXIF primitives ─────────────────────────────────────────────────── */

const TYPE_SIZE = {
  1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8,
};

// IFD0
const TAG_ORIENTATION = 0x0112;
const TAG_EXIF_IFD = 0x8769;
const TAG_GPS_IFD = 0x8825;
// Exif IFD
const TAG_DATETIME_ORIGINAL = 0x9003;
const TAG_OFFSET_TIME_ORIGINAL = 0x9011;
// GPS IFD
const TAG_GPS_LAT_REF = 0x0001;
const TAG_GPS_LAT = 0x0002;
const TAG_GPS_LON_REF = 0x0003;
const TAG_GPS_LON = 0x0004;
const TAG_GPS_TIMESTAMP = 0x0007;
const TAG_GPS_DATESTAMP = 0x001d;
const TAG_GPS_HPOS_ERROR = 0x001f;   // metres — iPhones write this; it is our accuracy

const MAX_IFD_ENTRIES = 1000;

/** Locate the APP1 segment that actually holds EXIF, and the frame dimensions.
 *  Returns { tiffStart, segmentEnd, width, height } with tiffStart -1 when absent. */
function scanJpeg(view) {
  if (view.getUint16(0) !== 0xffd8) throw new ExifError('not a JPEG');

  let p = 2;
  let tiffStart = -1;
  let segmentEnd = -1;
  let width = null;
  let height = null;
  let truncated = false;

  // Only these are real frame headers. C4 (DHT), C8 (JPG) and CC (DAC) share the SOFn
  // numeric range and are NOT frames — reading dimensions from them is a classic bug.
  const SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

  while (p + 4 <= view.byteLength) {
    // Skip fill bytes.
    while (p + 1 < view.byteLength && view.getUint8(p) === 0xff && view.getUint8(p + 1) === 0xff) p++;
    if (p + 1 >= view.byteLength) { truncated = true; break; }
    if (view.getUint8(p) !== 0xff) throw new ExifError(`bad marker at byte ${p}`);

    const marker = view.getUint8(p + 1);
    // Standalone markers carry no length field.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { p += 2; continue; }
    // SOS starts entropy-coded data; EOI ends the image. Nothing we want lies beyond.
    if (marker === 0xda || marker === 0xd9) break;

    if (p + 4 > view.byteLength) { truncated = true; break; }
    const len = view.getUint16(p + 2);
    if (len < 2) throw new ExifError(`bad segment length at byte ${p}`);
    if (p + 2 + len > view.byteLength) { truncated = true; break; }

    if (marker === 0xe1 && tiffStart === -1) {
      // APP1 is also used for XMP. Do not assume the first APP1 is EXIF — check the
      // signature and keep scanning if it is not.
      const sig = String.fromCharCode(
        view.getUint8(p + 4), view.getUint8(p + 5), view.getUint8(p + 6), view.getUint8(p + 7),
      );
      if (sig === 'Exif' && view.getUint8(p + 8) === 0 && view.getUint8(p + 9) === 0) {
        tiffStart = p + 10;
        segmentEnd = p + 2 + len;
      }
    }

    if (SOF.has(marker)) {
      height = view.getUint16(p + 5);
      width = view.getUint16(p + 7);
    }

    p += 2 + len;
  }

  return { tiffStart, segmentEnd, width, height, truncated };
}

function readIfd(view, tiffStart, ifdOffset, little, segmentEnd) {
  const base = tiffStart + ifdOffset;
  if (base + 2 > segmentEnd) throw new ExifError('IFD offset past end of EXIF segment');

  const count = view.getUint16(base, little);
  if (count > MAX_IFD_ENTRIES) throw new ExifError(`implausible IFD entry count: ${count}`);

  const entries = new Map();
  for (let i = 0; i < count; i++) {
    const e = base + 2 + i * 12;
    if (e + 12 > segmentEnd) throw new ExifError('IFD entry past end of EXIF segment');
    const tag = view.getUint16(e, little);
    const type = view.getUint16(e + 2, little);
    const n = view.getUint32(e + 4, little);
    const size = TYPE_SIZE[type];
    // Unknown types are legal forward-compatibility, not corruption. Skip quietly.
    if (size === undefined) continue;

    const byteLen = size * n;
    const at = byteLen <= 4 ? e + 8 : tiffStart + view.getUint32(e + 8, little);
    // APP1 payloads cap at 65533 bytes, so every legitimate offset is inside the segment.
    if (at < tiffStart || at + byteLen > segmentEnd) continue;

    entries.set(tag, { type, n, at });
  }
  const nextAt = base + 2 + count * 12;
  const next = nextAt + 4 <= segmentEnd ? view.getUint32(nextAt, little) : 0;
  return { entries, next };
}

function readAscii(view, entry) {
  let s = '';
  for (let i = 0; i < entry.n; i++) {
    const c = view.getUint8(entry.at + i);
    if (c === 0) break;
    s += String.fromCharCode(c);
  }
  return s.trim();
}

function readRational(view, at, little, signed) {
  const num = signed ? view.getInt32(at, little) : view.getUint32(at, little);
  const den = signed ? view.getInt32(at + 4, little) : view.getUint32(at + 4, little);
  // Never return 0 or Infinity for a broken rational — that is exactly the silent
  // fallback that puts a pin in the Gulf of Guinea.
  if (den === 0) throw new ExifError('zero denominator in a rational value');
  return num / den;
}

function readRationals(view, entry, little) {
  const signed = entry.type === 10;
  const out = [];
  for (let i = 0; i < entry.n; i++) out.push(readRational(view, entry.at + i * 8, little, signed));
  return out;
}

function dmsToDegrees(dms, ref) {
  if (dms.length < 3) throw new ExifError('GPS coordinate is not a 3-part rational');
  const deg = dms[0] + dms[1] / 60 + dms[2] / 3600;
  const r = ref.toUpperCase();
  if (r !== 'N' && r !== 'S' && r !== 'E' && r !== 'W') {
    throw new ExifError(`unrecognised GPS reference "${ref}"`);
  }
  return r === 'S' || r === 'W' ? -deg : deg;
}

/* ── the entry point ───────────────────────────────────────────────────────── */

/**
 * @param {ArrayBuffer} buf  the ORIGINAL file bytes (a 256 KB head slice is enough)
 * @returns {{
 *   container: 'jpeg'|'heif'|'png'|'unknown',
 *   truncated: boolean,
 *   pixelWidth: number|null, pixelHeight: number|null,
 *   hasExif: boolean,
 *   orientation: number|null,
 *   dateTimeOriginal: string|null,   // 'YYYY:MM:DD HH:MM:SS' verbatim, local wall time
 *   offsetTimeOriginal: string|null, // '+09:00' — what makes the above unambiguous
 *   gpsDateTimeUtc: string|null,     // ISO, preferred over dateTimeOriginal when present
 *   gps: { lat: number, lon: number, accuracyM: number|null }|null,
 * }}
 */
export function readImageMeta(buf) {
  const container = sniffContainer(buf);
  const out = {
    container,
    truncated: false,
    pixelWidth: null,
    pixelHeight: null,
    hasExif: false,
    orientation: null,
    dateTimeOriginal: null,
    offsetTimeOriginal: null,
    gpsDateTimeUtc: null,
    gps: null,
  };
  if (container !== 'jpeg') return out;

  const view = new DataView(buf);
  const { tiffStart, segmentEnd, width, height, truncated } = scanJpeg(view);
  out.pixelWidth = width;
  out.pixelHeight = height;
  out.truncated = truncated;
  if (tiffStart === -1) return out;
  out.hasExif = true;

  const bom = view.getUint16(tiffStart);
  if (bom !== 0x4949 && bom !== 0x4d4d) throw new ExifError('bad TIFF byte order mark');
  const little = bom === 0x4949;
  if (view.getUint16(tiffStart + 2, little) !== 42) throw new ExifError('bad TIFF magic');

  const ifd0 = readIfd(view, tiffStart, view.getUint32(tiffStart + 4, little), little, segmentEnd);

  const orient = ifd0.entries.get(TAG_ORIENTATION);
  if (orient !== undefined) {
    const v = view.getUint16(orient.at, little);
    if (v < 1 || v > 8) throw new ExifError(`orientation out of range: ${v}`);
    out.orientation = v;
  }

  const exifPtr = ifd0.entries.get(TAG_EXIF_IFD);
  if (exifPtr !== undefined) {
    const exif = readIfd(view, tiffStart, view.getUint32(exifPtr.at, little), little, segmentEnd);
    const dto = exif.entries.get(TAG_DATETIME_ORIGINAL);
    if (dto !== undefined) out.dateTimeOriginal = readAscii(view, dto) || null;
    const off = exif.entries.get(TAG_OFFSET_TIME_ORIGINAL);
    if (off !== undefined) out.offsetTimeOriginal = readAscii(view, off) || null;
  }

  const gpsPtr = ifd0.entries.get(TAG_GPS_IFD);
  if (gpsPtr !== undefined) {
    const gps = readIfd(view, tiffStart, view.getUint32(gpsPtr.at, little), little, segmentEnd);
    const latE = gps.entries.get(TAG_GPS_LAT);
    const lonE = gps.entries.get(TAG_GPS_LON);
    const latR = gps.entries.get(TAG_GPS_LAT_REF);
    const lonR = gps.entries.get(TAG_GPS_LON_REF);

    if (latE !== undefined && lonE !== undefined && latR !== undefined && lonR !== undefined) {
      const lat = dmsToDegrees(readRationals(view, latE, little), readAscii(view, latR));
      const lon = dmsToDegrees(readRationals(view, lonE, little), readAscii(view, lonR));
      if (Math.abs(lat) > 90 || Math.abs(lon) > 180) {
        throw new ExifError(`GPS out of range: ${lat}, ${lon}`);
      }
      // Some cameras write a zeroed GPS IFD. Honouring it drops a pin in the Gulf of
      // Guinea, so treat exact 0,0 as "no fix". Rejecting known-bad input is not a
      // silent fallback — it is the opposite.
      if (lat === 0 && lon === 0) {
        out.gps = null;
      } else {
        let accuracyM = null;
        const hpos = gps.entries.get(TAG_GPS_HPOS_ERROR);
        if (hpos !== undefined) accuracyM = readRationals(view, hpos, little)[0];
        out.gps = { lat, lon, accuracyM };
      }
    }

    // GPSDateStamp + GPSTimeStamp are UTC, so they give a timezone-unambiguous instant.
    // Prefer them over DateTimeOriginal, which is bare local wall time.
    const ds = gps.entries.get(TAG_GPS_DATESTAMP);
    const ts = gps.entries.get(TAG_GPS_TIMESTAMP);
    if (ds !== undefined && ts !== undefined) {
      const date = readAscii(view, ds).replace(/:/g, '-');
      const [h, m, s] = readRationals(view, ts, little);
      if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        const pad = (n) => String(Math.floor(n)).padStart(2, '0');
        out.gpsDateTimeUtc = `${date}T${pad(h)}:${pad(m)}:${pad(s)}Z`;
      }
    }
  }

  return out;
}

/** Best available capture instant as epoch-ms, or null. Prefers the UTC GPS clock;
 *  falls back to wall time plus its offset; then bare wall time read as local. */
export function captureTimeMs(meta) {
  if (meta.gpsDateTimeUtc !== null) {
    const t = Date.parse(meta.gpsDateTimeUtc);
    if (Number.isFinite(t)) return t;
  }
  if (meta.dateTimeOriginal !== null) {
    const m = meta.dateTimeOriginal.match(/^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/);
    if (m !== null) {
      const [, Y, Mo, D, H, Mi, S] = m;
      const iso = `${Y}-${Mo}-${D}T${H}:${Mi}:${S}${meta.offsetTimeOriginal ?? ''}`;
      const t = Date.parse(iso);
      if (Number.isFinite(t)) return t;
    }
  }
  return null;
}
