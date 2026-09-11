// EXIF reader. Local only, no framework:  node tests/exif.test.mjs
//
// The plan calls this the highest-value test in the project, because a silently-wrong
// coordinate is a pin on the wrong street that nobody ever notices.
//
// Fixtures are BUILT here rather than checked in as photos. That is deliberate: a
// synthetic JPEG lets us assert exact known coordinates, exercise both byte orders, and
// reproduce the malformed cases (zero denominator, zeroed GPS IFD, XMP-before-EXIF) that
// no real photo conveniently contains. Real-device behaviour is a separate question,
// answered by mockups/probe.html on the actual iPhone.

import assert from 'node:assert';
import { ExifError, captureTimeMs, readImageMeta, sniffContainer }
  from '../frontend/app/exif.js';

let pass = 0;
const check = (name, fn) => {
  try { fn(); pass++; }
  catch (e) { console.error(`FAIL  ${name}\n      ${e.message}`); process.exitCode = 1; }
};

/* ── fixture builder ───────────────────────────────────────────────────────
 * type: 2 ASCII, 3 SHORT, 4 LONG, 5 RATIONAL (values are [num, den] pairs). */

const TYPE_SIZE = { 2: 1, 3: 2, 4: 4, 5: 8 };

function entryByteLen(e) {
  if (e.type === 2) return e.values.length + 1;          // NUL-terminated
  return TYPE_SIZE[e.type] * e.values.length;
}
function entryCount(e) {
  return e.type === 2 ? e.values.length + 1 : e.values.length;
}

function writeValues(dv, at, e, little) {
  if (e.type === 2) {
    for (let i = 0; i < e.values.length; i++) dv.setUint8(at + i, e.values.charCodeAt(i));
    dv.setUint8(at + e.values.length, 0);
    return;
  }
  e.values.forEach((v, i) => {
    if (e.type === 3) dv.setUint16(at + i * 2, v, little);
    else if (e.type === 4) dv.setUint32(at + i * 4, v, little);
    else if (e.type === 5) {
      dv.setUint32(at + i * 8, v[0], little);
      dv.setUint32(at + i * 8 + 4, v[1], little);
    }
  });
}

function buildTiff({ little = true, ifd0 = [], exif = [], gps = [] }) {
  const has = (a) => a.length > 0;
  const ifd0Count = ifd0.length + (has(exif) ? 1 : 0) + (has(gps) ? 1 : 0);
  const size = (n) => 2 + 12 * n + 4;

  const ifd0At = 8;
  const exifAt = ifd0At + size(ifd0Count);
  const gpsAt = exifAt + (has(exif) ? size(exif.length) : 0);
  let heap = gpsAt + (has(gps) ? size(gps.length) : 0);

  const heapNeeded = [...ifd0, ...exif, ...gps]
    .filter((e) => entryByteLen(e) > 4)
    .reduce((s, e) => s + entryByteLen(e) + (entryByteLen(e) % 2), 0);

  const buf = new ArrayBuffer(heap + heapNeeded + 8);
  const dv = new DataView(buf);

  dv.setUint16(0, little ? 0x4949 : 0x4d4d);
  dv.setUint16(2, 42, little);
  dv.setUint32(4, ifd0At, little);

  const writeIfd = (at, entries, next) => {
    dv.setUint16(at, entries.length, little);
    entries.forEach((e, i) => {
      const p = at + 2 + i * 12;
      dv.setUint16(p, e.tag, little);
      dv.setUint16(p + 2, e.type, little);
      dv.setUint32(p + 4, entryCount(e), little);
      const len = entryByteLen(e);
      if (len <= 4) {
        writeValues(dv, p + 8, e, little);
      } else {
        dv.setUint32(p + 8, heap, little);
        writeValues(dv, heap, e, little);
        heap += len + (len % 2);
      }
    });
    dv.setUint32(at + 2 + entries.length * 12, next, little);
  };

  const ifd0All = [...ifd0];
  if (has(exif)) ifd0All.push({ tag: 0x8769, type: 4, values: [exifAt] });
  if (has(gps)) ifd0All.push({ tag: 0x8825, type: 4, values: [gpsAt] });

  writeIfd(ifd0At, ifd0All, 0);
  if (has(exif)) writeIfd(exifAt, exif, 0);
  if (has(gps)) writeIfd(gpsAt, gps, 0);

  return new Uint8Array(buf);
}

/** Wrap TIFF bytes in a JPEG with an SOF0 frame, optionally preceded by an XMP APP1. */
function buildJpeg(tiff, { width = 4032, height = 3024, xmpFirst = false } = {}) {
  const parts = [new Uint8Array([0xff, 0xd8])];

  if (xmpFirst) {
    const sig = 'http://ns.adobe.com/xap/1.0/\0';
    const body = new Uint8Array(sig.length + 4);
    for (let i = 0; i < sig.length; i++) body[i] = sig.charCodeAt(i);
    const len = body.length + 2;
    parts.push(new Uint8Array([0xff, 0xe1, len >> 8, len & 0xff]), body);
  }

  if (tiff !== null) {
    const head = new Uint8Array([0x45, 0x78, 0x69, 0x66, 0, 0]);   // "Exif\0\0"
    const len = head.length + tiff.length + 2;
    parts.push(new Uint8Array([0xff, 0xe1, len >> 8, len & 0xff]), head, tiff);
  }

  // SOF0: len(2) precision(1) height(2) width(2) ncomp(1) + 3 bytes per component
  parts.push(new Uint8Array([
    0xff, 0xc0, 0x00, 0x11, 0x08,
    height >> 8, height & 0xff, width >> 8, width & 0xff,
    0x03, 1, 0x22, 0, 2, 0x11, 0, 3, 0x11, 0,
  ]));
  parts.push(new Uint8Array([0xff, 0xda, 0x00, 0x02]));   // SOS
  parts.push(new Uint8Array([0xff, 0xd9]));               // EOI

  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out.buffer;
}

// Victoria BC: 48°25'35.8"N 123°21'01.8"W
const LAT_DMS = [[48, 1], [25, 1], [358, 10]];
const LON_DMS = [[123, 1], [21, 1], [18, 10]];
const EXPECT_LAT = 48 + 25 / 60 + 35.8 / 3600;
const EXPECT_LON = -(123 + 21 / 60 + 1.8 / 3600);

const gpsEntries = (extra = []) => [
  { tag: 0x0001, type: 2, values: 'N' },
  { tag: 0x0002, type: 5, values: LAT_DMS },
  { tag: 0x0003, type: 2, values: 'W' },
  { tag: 0x0004, type: 5, values: LON_DMS },
  ...extra,
];

/* ── tests ─────────────────────────────────────────────────────────────────── */

check('containers are sniffed from bytes, never from file.type', () => {
  assert.strictEqual(sniffContainer(buildJpeg(null)), 'jpeg');
  const png = new Uint8Array(16);
  png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.strictEqual(sniffContainer(png.buffer), 'png');
  const heic = new Uint8Array(16);
  heic.set([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70], 0);   // 'ftyp'
  heic.set([0x68, 0x65, 0x69, 0x63], 8);                // 'heic'
  assert.strictEqual(sniffContainer(heic.buffer), 'heif');
});

check('GPS decodes to the right place, little-endian', () => {
  const meta = readImageMeta(buildJpeg(buildTiff({ little: true, gps: gpsEntries() })));
  assert.ok(meta.gps !== null, 'expected a fix');
  assert.ok(Math.abs(meta.gps.lat - EXPECT_LAT) < 1e-9, `lat ${meta.gps.lat}`);
  assert.ok(Math.abs(meta.gps.lon - EXPECT_LON) < 1e-9, `lon ${meta.gps.lon}`);
});

check('GPS decodes identically big-endian', () => {
  const meta = readImageMeta(buildJpeg(buildTiff({ little: false, gps: gpsEntries() })));
  assert.ok(Math.abs(meta.gps.lat - EXPECT_LAT) < 1e-9);
  assert.ok(Math.abs(meta.gps.lon - EXPECT_LON) < 1e-9);
});

check('S and W both negate', () => {
  const south = gpsEntries();
  south[0] = { tag: 0x0001, type: 2, values: 'S' };
  const meta = readImageMeta(buildJpeg(buildTiff({ gps: south })));
  assert.ok(meta.gps.lat < 0, 'S must be negative');
  assert.ok(meta.gps.lon < 0, 'W must be negative');
});

check('GPSHPositioningError becomes our accuracy', () => {
  const meta = readImageMeta(buildJpeg(buildTiff({
    gps: gpsEntries([{ tag: 0x001f, type: 5, values: [[65, 4]] }]),
  })));
  assert.strictEqual(meta.gps.accuracyM, 16.25);
});

check('a zeroed GPS IFD is treated as no fix, not as the Gulf of Guinea', () => {
  const zeroed = [
    { tag: 0x0001, type: 2, values: 'N' },
    { tag: 0x0002, type: 5, values: [[0, 1], [0, 1], [0, 1]] },
    { tag: 0x0003, type: 2, values: 'E' },
    { tag: 0x0004, type: 5, values: [[0, 1], [0, 1], [0, 1]] },
  ];
  const meta = readImageMeta(buildJpeg(buildTiff({ gps: zeroed })));
  assert.strictEqual(meta.gps, null);
});

check('a zero denominator throws rather than yielding Infinity', () => {
  const bad = gpsEntries();
  bad[1] = { tag: 0x0002, type: 5, values: [[48, 0], [25, 1], [0, 1]] };
  assert.throws(() => readImageMeta(buildJpeg(buildTiff({ gps: bad }))), ExifError);
});

check('orientation is read, and an out-of-range value throws', () => {
  const ok = readImageMeta(buildJpeg(buildTiff({
    ifd0: [{ tag: 0x0112, type: 3, values: [6] }],
  })));
  assert.strictEqual(ok.orientation, 6);
  assert.throws(() => readImageMeta(buildJpeg(buildTiff({
    ifd0: [{ tag: 0x0112, type: 3, values: [11] }],
  }))), ExifError);
});

check('the frame dimensions come from a real SOFn', () => {
  const meta = readImageMeta(buildJpeg(buildTiff({ gps: gpsEntries() }), { width: 8064, height: 6048 }));
  assert.strictEqual(meta.pixelWidth, 8064);
  assert.strictEqual(meta.pixelHeight, 6048);
  // This is what the resize stage uses to catch a 48 MP source before decoding it into
  // a silently-blank canvas.
  assert.ok(meta.pixelWidth * meta.pixelHeight > 30_000_000);
});

check('an XMP APP1 before the EXIF one does not shadow it', () => {
  const meta = readImageMeta(buildJpeg(buildTiff({ gps: gpsEntries() }), { xmpFirst: true }));
  assert.strictEqual(meta.hasExif, true, 'EXIF was missed because XMP came first');
  assert.ok(meta.gps !== null);
});

check('a JPEG with no EXIF at all reports that plainly', () => {
  const meta = readImageMeta(buildJpeg(null));
  assert.strictEqual(meta.container, 'jpeg');
  assert.strictEqual(meta.hasExif, false);
  assert.strictEqual(meta.gps, null);
  assert.strictEqual(meta.pixelWidth, 4032, 'dimensions should still be read');
});

check('capture time prefers the UTC GPS clock over local wall time', () => {
  const meta = readImageMeta(buildJpeg(buildTiff({
    exif: [
      { tag: 0x9003, type: 2, values: '2026:08:14 18:42:00' },
      { tag: 0x9011, type: 2, values: '-07:00' },
    ],
    gps: gpsEntries([
      { tag: 0x001d, type: 2, values: '2026:08:15' },
      { tag: 0x0007, type: 5, values: [[1, 1], [42, 1], [0, 1]] },
    ]),
  })));
  assert.strictEqual(meta.dateTimeOriginal, '2026:08:14 18:42:00');
  assert.strictEqual(meta.offsetTimeOriginal, '-07:00');
  assert.strictEqual(meta.gpsDateTimeUtc, '2026-08-15T01:42:00Z');
  // Both describe the same instant; the GPS one wins because it is unambiguous.
  assert.strictEqual(captureTimeMs(meta), Date.parse('2026-08-15T01:42:00Z'));
});

check('wall time plus offset is used when there is no GPS clock', () => {
  const meta = readImageMeta(buildJpeg(buildTiff({
    exif: [
      { tag: 0x9003, type: 2, values: '2026:08:14 18:42:00' },
      { tag: 0x9011, type: 2, values: '-07:00' },
    ],
  })));
  assert.strictEqual(captureTimeMs(meta), Date.parse('2026-08-15T01:42:00Z'));
});

check('no usable time yields null rather than "now"', () => {
  assert.strictEqual(captureTimeMs(readImageMeta(buildJpeg(null))), null);
});

check('a non-JPEG is reported, not parsed', () => {
  const heic = new Uint8Array(32);
  heic.set([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70], 0);
  heic.set([0x68, 0x65, 0x69, 0x63], 8);
  const meta = readImageMeta(heic.buffer);
  assert.strictEqual(meta.container, 'heif');
  assert.strictEqual(meta.hasExif, false);
});

check('a truncated file is flagged rather than throwing', () => {
  const full = new Uint8Array(buildJpeg(buildTiff({ gps: gpsEntries() })));
  const meta = readImageMeta(full.slice(0, 24).buffer);
  assert.strictEqual(meta.truncated, true);
});

console.log(`exif: ${pass} checks passed`);
