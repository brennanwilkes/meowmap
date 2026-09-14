/**
 * Browse every photo in the database and delete the ones you do not want.
 *
 *   npm run photos              # live sightings
 *   npm run photos -- --all     # include soft-deleted tombstones
 *
 *   j / k / ↑ / ↓   move          space   mark
 *   o               open in a browser     d   delete this one
 *   a               mark all              D   delete everything marked
 *   u               undelete a tombstone  r   reload
 *   q               quit
 *
 * Deletion is REAL and immediate: the row, and any photo object no surviving row still
 * points at. It asks first, and it tells you exactly what it is about to destroy.
 */

import { execFile } from 'node:child_process';
import { API_BASE, d1, deviceName, PREFIX, r2Delete } from './cf.mjs';
import { drawImage, PREVIEW_HELP, previewMode } from './preview.mjs';
import { box, c, CSI, onKey, paint, readKey, screen, truncate } from './tui.mjs';

const SHOW_DELETED = process.argv.includes('--all');

const state = {
  rows: [],
  i: 0,
  marked: new Set(),        // sighting ids
  message: '',
  thumbs: new Map(),        // id -> Buffer, fetched lazily and kept
  busy: false,
};

function load() {
  const where = SHOW_DELETED ? '' : 'WHERE s.deleted_at IS NULL';
  state.rows = d1(`SELECT s.id, s.client_id, s.cat_id, s.device_id, s.lat, s.lon,
                          s.location_source, s.accuracy_m, s.seen_at, s.coat, s.size,
                          s.petted, s.note, s.photo_full, s.photo_thumb, s.photo_w,
                          s.photo_h, s.created_at, s.deleted_at, c.name AS cat_name
                   FROM sightings s LEFT JOIN cats c ON c.id = s.cat_id
                   ${where} ORDER BY s.seen_at DESC`);
  for (const id of state.marked) {
    if (!state.rows.some((r) => r.id === id)) state.marked.delete(id);
  }
  if (state.i >= state.rows.length) state.i = Math.max(0, state.rows.length - 1);
}

async function thumb(row) {
  if (state.thumbs.has(row.id)) return state.thumbs.get(row.id);
  try {
    const res = await fetch(`${API_BASE}/photo/${row.photo_thumb}`);
    // A null is cached deliberately: a missing photo should be reported once, not
    // re-fetched on every keypress.
    const buf = res.ok ? Buffer.from(await res.arrayBuffer()) : null;
    state.thumbs.set(row.id, buf);
    return buf;
  } catch {
    state.thumbs.set(row.id, null);
    return null;
  }
}

const fmt = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 16);

function detailLines(s) {
  // cat_id can legitimately be 0, so this checks null rather than falsiness.
  const cat = s.cat_id === null || s.cat_id === undefined
    ? paint('not identified', c.grey)
    : paint(`${s.cat_name ?? 'unnamed'} (#${s.cat_id})`, c.pink);
  const acc = s.accuracy_m === null ? '' : ` ±${s.accuracy_m}m`;
  const tags = [s.coat, s.size, s.petted].filter((x) => x !== null && x !== '').join(' · ');

  const lines = [
    `${paint('cat      ', c.grey)} ${cat}`,
    `${paint('seen     ', c.grey)} ${fmt(s.seen_at)} UTC`,
    `${paint('uploaded ', c.grey)} ${fmt(s.created_at)} UTC`,
    `${paint('device   ', c.grey)} ${deviceName(s.device_id)}`,
    `${paint('where    ', c.grey)} ${s.lat.toFixed(6)}, ${s.lon.toFixed(6)} `
      + paint(`(${s.location_source}${acc})`, c.grey),
    `${paint('photo    ', c.grey)} ${s.photo_w}x${s.photo_h}`,
  ];
  if (tags !== '') lines.push(`${paint('tags     ', c.grey)} ${paint(tags, c.yellow)}`);
  if (s.note !== null && s.note !== '') lines.push(`${paint('note     ', c.grey)} ${s.note}`);
  if (s.deleted_at !== null) {
    lines.push(paint(`DELETED ${fmt(s.deleted_at)} — its photos stay pinned until purged`, c.red));
  }
  return lines;
}

function render() {
  screen.clear();
  const cols = screen.cols;

  if (state.rows.length === 0) {
    process.stdout.write(paint('\n  No sightings.\n', c.grey));
    process.stdout.write(paint('  q to quit\n', c.grey));
    return;
  }

  const s = state.rows[state.i];
  const marked = state.marked.has(s.id);
  const title = `sighting ${s.id}  ${paint(`${state.i + 1}/${state.rows.length}`, c.grey)}`
    + (marked ? `  ${paint('● MARKED', c.yellow)}` : '');

  const inner = Math.min(72, cols - 6);
  for (const line of box(detailLines(s), { title, colour: c.blue, inner })) {
    process.stdout.write(`  ${truncate(line, cols - 2)}\n`);
  }

  // The list rail: where you are in the set, without leaving the detail view.
  const railWidth = Math.min(state.rows.length, Math.max(10, cols - 8));
  let rail = '';
  for (let i = 0; i < Math.min(state.rows.length, railWidth); i++) {
    const r = state.rows[i];
    if (i === state.i) rail += paint('█', c.blue);
    else if (state.marked.has(r.id)) rail += paint('▓', c.yellow);
    else if (r.deleted_at !== null) rail += paint('░', c.red);
    else rail += paint('░', c.grey);
  }
  process.stdout.write(`  ${rail}\n`);

  if (previewMode() === 'none') {
    process.stdout.write(paint(`\n  ${PREVIEW_HELP}\n`, c.grey));
  } else {
    process.stdout.write('\n');
    const buf = state.thumbs.get(s.id);
    if (buf === undefined) process.stdout.write(paint('  loading photo…\n', c.grey));
    else if (buf === null) process.stdout.write(paint('  PHOTO MISSING from R2\n', c.red));
    else {
      const rows = Math.max(6, Math.min(16, screen.rows - 16));
      drawImage(buf, Math.min(40, cols - 4), rows);
      process.stdout.write(`${CSI}${rows + 1}B\r`);
    }
  }

  if (state.message !== '') process.stdout.write(`\n  ${state.message}\n`);

  const keys = [
    ['j/k', 'move'], ['space', 'mark'], ['a', 'all'], ['o', 'open'],
    ['d', 'delete'], ['D', 'delete marked'], ['r', 'reload'], ['q', 'quit'],
  ];
  const bar = keys.map(([k, v]) => `${paint(k, c.bold)} ${paint(v, c.grey)}`).join('  ');
  process.stdout.write(`\n  ${truncate(bar, cols - 4)}\n`);
}

function openInBrowser(row) {
  execFile('xdg-open', [`${API_BASE}/photo/${row.photo_full}`], (err) => {
    if (err !== null) state.message = paint(`could not open a browser: ${err.message}`, c.red);
  });
  state.message = paint('opened in your browser', c.green);
}

/**
 * Delete rows and then any photo they referenced that nothing else still does.
 *
 * ROW FIRST, OBJECT SECOND, and a failed object delete is reported rather than thrown.
 * The reverse order would leave a row pointing at a photo that no longer exists, which
 * is the worse of the two broken states. This order can leave an orphaned object, which
 * `npm run reconcile -- --gc` cleans up — and that is exactly what happened the first
 * time this script ran with a wrong wrangler subcommand: the rows went, the delete threw,
 * and the whole process died mid-way leaving no record of which objects were stranded.
 */
function purge(ids) {
  const rows = state.rows.filter((r) => ids.includes(r.id));
  const hashes = new Set();
  for (const r of rows) {
    if (typeof r.photo_full === 'string') hashes.add(r.photo_full);
    if (typeof r.photo_thumb === 'string') hashes.add(r.photo_thumb);
  }

  d1(`DELETE FROM sightings WHERE id IN (${ids.join(',')})`);
  d1(`UPDATE app_meta SET data_version = data_version + 1, updated_at = ${Date.now()} WHERE id = 1`);

  const still = new Set(
    d1('SELECT photo_full AS k FROM sightings UNION SELECT photo_thumb FROM sightings')
      .map((r) => r.k),
  );
  let freed = 0;
  const stranded = [];
  for (const h of hashes) {
    if (still.has(h)) continue;
    try {
      r2Delete(`${PREFIX}${h}`);
      freed++;
    } catch (err) {
      stranded.push(h);
      console.error(`[photos] could not delete ${PREFIX}${h}: ${err.message}`);
    }
  }
  if (freed > 0) {
    d1(`UPDATE app_meta SET r2_objects = MAX(0, r2_objects - ${freed}), `
       + `updated_at = ${Date.now()} WHERE id = 1`);
  }

  state.message = stranded.length === 0
    ? paint(`deleted ${ids.length} sighting(s) and ${freed} photo object(s)`, c.green)
    : paint(`deleted ${ids.length} row(s); ${stranded.length} object(s) STRANDED — run `
            + 'npm run gc', c.red);
  for (const id of ids) state.marked.delete(id);
  state.thumbs.clear();
}

async function confirm(question) {
  state.message = `${paint(question, c.yellow)} ${paint('[y/N]', c.grey)}`;
  render();
  const key = await readKey();
  state.message = '';
  return key === 'y' || key === 'Y';
}

async function main() {
  load();
  if (!process.stdin.isTTY) {
    console.error('photos.mjs needs an interactive terminal.');
    process.exit(1);
  }

  screen.enter();
  let quit = false;
  let off = null;

  const refreshThumb = async () => {
    const s = state.rows[state.i];
    if (s === undefined || previewMode() === 'none') return;
    if (state.thumbs.has(s.id)) return;
    await thumb(s);
    if (!quit) render();
  };

  const handle = async (key) => {
    if (state.busy) return;
    const s = state.rows[state.i];

    switch (key) {
      case 'q': case 'ctrl-c': quit = true; return;
      case 'j': case 'down': case 'n': state.i = Math.min(state.i + 1, state.rows.length - 1); break;
      case 'k': case 'up': case 'p': state.i = Math.max(state.i - 1, 0); break;
      case 'g': state.i = 0; break;
      case 'G': state.i = state.rows.length - 1; break;
      case ' ':
        if (s !== undefined) {
          if (state.marked.has(s.id)) state.marked.delete(s.id); else state.marked.add(s.id);
        }
        break;
      case 'a':
        if (state.marked.size === state.rows.length) state.marked.clear();
        else for (const r of state.rows) state.marked.add(r.id);
        break;
      case 'o': if (s !== undefined) openInBrowser(s); break;
      case 'r': state.thumbs.clear(); load(); state.message = paint('reloaded', c.green); break;
      case 'd':
        if (s === undefined) break;
        state.busy = true;
        if (await confirm(`Delete sighting ${s.id} and its photos? This cannot be undone.`)) {
          purge([s.id]);
          load();
        }
        state.busy = false;
        break;
      case 'D': {
        if (state.marked.size === 0) { state.message = paint('nothing marked', c.grey); break; }
        state.busy = true;
        const ids = [...state.marked];
        if (await confirm(`Delete ${ids.length} sighting(s) and their photos? Cannot be undone.`)) {
          purge(ids);
          load();
        }
        state.busy = false;
        break;
      }
      default: break;
    }
    render();
    refreshThumb();
  };

  off = onKey((key) => {
    handle(key).catch((err) => {
      state.message = paint(err.message, c.red);
      render();
    });
    if (quit) {
      off();
      screen.leave();
      process.exit(0);
    }
  });

  render();
  refreshThumb();
}

main();
