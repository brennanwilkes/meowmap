/**
 * Browse the photos in the database and delete the ones you do not want.
 *
 *   npm run photos              # live sightings
 *   npm run photos -- --all     # include soft-deleted tombstones
 *
 *   j / k / ↑ / ↓   move
 *   o               open in a browser
 *   d               delete this one
 *   r               reload
 *   q               quit
 *
 * ONE key handler, one mode variable. An earlier version awaited a nested key listener
 * for the confirmation prompt, whose teardown paused stdin process-wide and took the
 * main listener with it — the app stopped responding after the first confirmation and
 * looked frozen. A modal is a mode, not a second listener.
 *
 * Every wrangler call is synchronous and takes seconds, which blocks this process
 * completely. So each one is announced BEFORE it starts and the frame is flushed first;
 * a UI that goes quiet for six seconds with no explanation is indistinguishable from a
 * hang, which is exactly how the freeze presented.
 */

import { execFile } from 'node:child_process';
import { API_BASE, d1Many, deviceName, journalForDelete, sweepJournal } from './cf.mjs';
import { drawImage, PREVIEW_HELP, previewMode } from './preview.mjs';
import { box, c, CSI, onKey, paint, screen, truncate } from './tui.mjs';

const SHOW_DELETED = process.argv.includes('--all');

/** 'browse' waits for navigation, 'confirm' waits for y/n, 'busy' ignores everything. */
let mode = 'browse';
let rows = [];
let i = 0;
let message = '';
const thumbs = new Map();     // id -> Buffer | null

const fmt = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 16);

/** Give the terminal a chance to paint before a synchronous call blocks everything. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function load() {
  const where = SHOW_DELETED ? '' : 'WHERE s.deleted_at IS NULL';
  rows = d1(`SELECT s.id, s.cat_id, s.device_id, s.lat, s.lon, s.location_source,
                    s.accuracy_m, s.seen_at, s.coat, s.size, s.petted, s.note,
                    s.photo_full, s.photo_thumb, s.photo_w, s.photo_h, s.created_at,
                    s.deleted_at, c.name AS cat_name
             FROM sightings s LEFT JOIN cats c ON c.id = s.cat_id
             ${where} ORDER BY s.seen_at DESC`);
  if (i >= rows.length) i = Math.max(0, rows.length - 1);
}

async function thumb(row) {
  if (thumbs.has(row.id)) return thumbs.get(row.id);
  try {
    const res = await fetch(`${API_BASE}/photo/${row.photo_thumb}`);
    // A null is cached on purpose: a missing photo is reported once, not re-fetched on
    // every keypress.
    thumbs.set(row.id, res.ok ? Buffer.from(await res.arrayBuffer()) : null);
  } catch {
    thumbs.set(row.id, null);
  }
  return thumbs.get(row.id);
}

function detailLines(s) {
  // cat_id can legitimately be 0, so this checks null rather than falsiness.
  const cat = s.cat_id === null || s.cat_id === undefined
    ? paint('not identified', c.grey)
    : paint(`${s.cat_name ?? 'unnamed'} (#${s.cat_id})`, c.pink);
  const acc = s.accuracy_m === null ? '' : ` ±${s.accuracy_m}m`;
  const tags = [s.coat, s.size, s.petted].filter((x) => x !== null && x !== '').join(' · ');

  const lines = [
    `${paint('cat    ', c.grey)} ${cat}`,
    `${paint('seen   ', c.grey)} ${fmt(s.seen_at)} UTC`,
    `${paint('device ', c.grey)} ${deviceName(s.device_id)}`,
    `${paint('where  ', c.grey)} ${s.lat.toFixed(5)}, ${s.lon.toFixed(5)} `
      + paint(`(${s.location_source}${acc})`, c.grey),
  ];
  if (tags !== '') lines.push(`${paint('tags   ', c.grey)} ${paint(tags, c.yellow)}`);
  if (s.note !== null && s.note !== '') lines.push(`${paint('note   ', c.grey)} ${s.note}`);
  if (s.deleted_at !== null) lines.push(paint(`deleted ${fmt(s.deleted_at)}`, c.red));
  return lines;
}

function render() {
  screen.clear();
  const cols = screen.cols;

  if (rows.length === 0) {
    process.stdout.write(paint('\n  Nothing here.\n\n', c.grey));
    process.stdout.write(paint('  q quit\n', c.grey));
    return;
  }

  const s = rows[i];
  const title = `sighting ${s.id}  ${paint(`${i + 1} of ${rows.length}`, c.grey)}`;
  for (const line of box(detailLines(s), { title, colour: c.blue, inner: Math.min(64, cols - 6) })) {
    process.stdout.write(`  ${truncate(line, cols - 2)}\n`);
  }

  if (previewMode() === 'none') {
    process.stdout.write(paint(`\n  ${PREVIEW_HELP}\n`, c.grey));
  } else {
    process.stdout.write('\n');
    const buf = thumbs.get(s.id);
    if (buf === undefined) process.stdout.write(paint('  loading photo…\n', c.grey));
    else if (buf === null) process.stdout.write(paint('  photo missing from R2\n', c.red));
    else {
      const h = Math.max(6, Math.min(14, screen.rows - 14));
      drawImage(buf, Math.min(36, cols - 4), h);
      process.stdout.write(`${CSI}${h + 1}B\r`);
    }
  }

  process.stdout.write('\n');
  if (mode === 'confirm') {
    process.stdout.write(`  ${paint(`Delete sighting ${s.id} and its photos?`, c.yellow)}`
      + ` ${paint('y', c.bold)}${paint('/n', c.grey)}\n`);
  } else if (mode === 'busy') {
    process.stdout.write(`  ${paint(message, c.yellow)}\n`);
  } else {
    if (message !== '') process.stdout.write(`  ${message}\n\n`);
    const keys = [['j/k', 'move'], ['o', 'open'], ['d', 'delete'], ['r', 'reload'], ['q', 'quit']];
    process.stdout.write(`  ${keys.map(([k, v]) => `${paint(k, c.bold)} ${paint(v, c.grey)}`).join('   ')}\n`);
  }
}

/** Announce, paint, THEN block. The order is the whole point. */
async function working(text, fn) {
  mode = 'busy';
  message = text;
  render();
  await flush();
  try {
    return fn();
  } finally {
    mode = 'browse';
  }
}

/**
 * Delete a row, then any photo it referenced that nothing else still does.
 *
 * ROW FIRST, OBJECT SECOND, and a failed object delete is reported rather than thrown.
 * The reverse order leaves a row pointing at a photo that does not exist, which is the
 * worse broken state. This order can strand an object, which `npm run gc` sweeps.
 */
/**
 * JOURNAL, then delete rows, then sweep — all in that order.
 *
 * Writing the hashes down first is what makes a crash recoverable with wrangler alone.
 * The old order deleted the row and then the object, so when the process died in
 * between, nothing in D1 named the object any more and finding it needed a bucket
 * listing wrangler cannot do. That stranded four objects for real.
 */
function purgeOne(s) {
  const hashes = [s.photo_full, s.photo_thumb].filter((h) => typeof h === 'string');
  d1Many([
    ...journalForDelete(hashes, `sighting ${s.id}`),
    `DELETE FROM sightings WHERE id = ${s.id}`,
    `UPDATE app_meta SET data_version = data_version + 1, updated_at = ${Date.now()} WHERE id = 1`,
  ]);
  thumbs.delete(s.id);
  return sweepJournal().failed;
}

function openInBrowser(s) {
  execFile('xdg-open', [`${API_BASE}/photo/${s.photo_full}`], (err) => {
    if (err !== null) { message = paint(`could not open a browser: ${err.message}`, c.red); render(); }
  });
  message = paint('opened in your browser', c.green);
}

async function loadThumb() {
  const s = rows[i];
  if (s === undefined || previewMode() === 'none' || thumbs.has(s.id)) return;
  await thumb(s);
  render();
}

async function handle(key) {
  if (mode === 'busy') return;
  const s = rows[i];

  if (mode === 'confirm') {
    mode = 'browse';
    if (key === 'y' || key === 'Y') {
      const stranded = await working(`Deleting sighting ${s.id} and its photos…`,
        () => purgeOne(s));
      await working('Reloading…', load);
      message = stranded.length === 0
        ? paint(`deleted sighting ${s.id}`, c.green)
        : paint(`row deleted; ${stranded.length} object(s) stranded — run npm run gc`, c.red);
    } else {
      message = paint('cancelled', c.grey);
    }
    render();
    loadThumb();
    return;
  }

  switch (key) {
    case 'j': case 'down': case 'n': i = Math.min(i + 1, rows.length - 1); message = ''; break;
    case 'k': case 'up': case 'p': i = Math.max(i - 1, 0); message = ''; break;
    case 'g': i = 0; break;
    case 'G': i = rows.length - 1; break;
    case 'o': if (s !== undefined) openInBrowser(s); break;
    case 'd':
      if (s === undefined) break;
      mode = 'confirm';
      break;
    case 'r':
      thumbs.clear();
      await working('Reloading…', load);
      message = paint('reloaded', c.green);
      break;
    default: break;
  }
  render();
  loadThumb();
}

function main() {
  if (!process.stdin.isTTY) {
    console.error('photos.mjs needs an interactive terminal.');
    process.exit(1);
  }
  process.stdout.write('Loading…\n');
  load();

  screen.enter();
  const off = onKey((key) => {
    // ctrl-c always gets you out. `q` only quits from browse — during a confirmation it
    // falls through and cancels, so the prompt can never swallow a keystroke and look
    // stuck, and it is ignored while busy because the screen buffer is mid-swap.
    if (key === 'ctrl-c' || (key === 'q' && mode === 'browse')) {
      off();
      screen.leave();
      process.exit(0);
    }
    handle(key).catch((err) => {
      mode = 'browse';
      message = paint(err.message, c.red);
      render();
    });
  });

  render();
  loadThumb();
}

main();
