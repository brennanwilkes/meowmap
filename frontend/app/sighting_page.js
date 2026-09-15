import {
  DEFAULT_TILE_ID, LS, MAX_NOTE_LEN, TILE_SOURCES,
} from '../config.js';
import { deleteSighting, patchSighting, photoUrl } from './api.js';
import { catColour, displayName, inkFor } from './catcolor.js';
import { pettedRow, wireChips } from './components/chips.js';
import { getPref } from './device.js';
import { $, esc } from './dom.js';
import { back, navigate } from './nav.js';
import { LOCATION_SOURCE } from './pipeline.js';
import { nameStyle } from './components/filmstrip.js';
import { splitToNewCat } from './identity.js';
import { keepSized } from './minimap.js';
import * as store from './store.js';
import * as turnstile from './turnstile.js';

/* One sighting: its note, when it was taken, and where.
 *
 * WHAT IS *NOT* HERE: coat and size. Those describe the animal rather than the
 * encounter, so since migration 003 they live on the cat and are edited on the cat page.
 *
 * PETTED *IS* HERE, since 004. It is the one tag that is genuinely about the encounter
 * — it is stamped on this polaroid, and the day she finally managed to pet him does not
 * retroactively make the photo from March a petting. So this page is the photo's own
 * facts: when, where, what she wrote on it, and whether she got to touch them.
 *
 * EDITS ARE EXPLICIT, NOT LIVE. Every PATCH is a D1 write plus an app_meta bump against
 * a hard 100k/day cap, and a chip row is very easy to fiddle with — autosaving each tap
 * would turn one decision into eight writes. So changes accumulate locally and a Save
 * button appears once something actually differs.
 *
 * `location_source` is stored but never displayed. Brennan: "if its just the source of
 * the data then not required, store it, but dont display" — the only thing worth
 * surfacing is the accuracy, and only when it is bad enough to matter.
 */

let root = null;
let sightingId = null;
let unsubscribe = null;
let draft = null;        // the working copy; null means "showing server state"
let original = null;
let miniMap = null;
let miniMarker = null;
let unsize = null;
let saving = false;

function dirty() {
  if (draft === null || original === null) return false;
  return draft.note !== original.note
    || draft.seenAt !== original.seenAt
    || draft.petted !== original.petted
    || draft.lat !== original.lat
    || draft.lon !== original.lon;
}

/** `<input type="datetime-local">` wants local wall time with no zone suffix. */
function localInputValue(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
    + `T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function render(state) {
  // Never rebuild under an active field or an unsaved edit: both would discard work.
  const active = document.activeElement;
  if (active !== null && root.contains(active) && active.tagName === 'INPUT') return;
  if (dirty()) return;

  if (unsize !== null) { unsize(); unsize = null; }
  if (miniMap !== null) { miniMap.remove(); miniMap = null; miniMarker = null; }

  const s = store.sightingById(sightingId, state);
  if (s === null) {
    root.innerHTML = '<div class="pad"><p class="empty">That sighting is not here any more.</p></div>';
    return;
  }

  original = snapshot(s);
  draft = snapshot(s);

  /* WITH its sightings: the split needs to know whether this is the cat's only photo, and
   * inherits the cat's description for the new one. */
  const cat = store.catsWithSightings(state).find((c) => c.id === s.catId) ?? null;
  const colour = catColour(s.catId);
  const ring = colour === null ? 'var(--rule)' : colour.hex;

  root.innerHTML = `
    <div class="pad" style="--ring:${esc(ring)};--ring-ink:${esc(inkFor(s.catId))}">
      <figure class="print hero">
        <span class="tape" style="top:-11px;left:50%;margin-left:-44px;transform:rotate(-2deg)"></span>
        <img src="${esc(photoUrl(s.photoFull))}" alt="" crossorigin="anonymous"
             width="${esc(String(s.photoW))}" height="${esc(String(s.photoH))}">
      </figure>
      ${cat === null ? '' : `<div class="name-line">
        <button type="button" class="nm ${esc(nameStyle(s.id))}" id="to-cat">${esc(displayName(cat))}</button>
      </div>`}

      <hr class="rule">
      <label class="field">
        <span>Note <em>(optional)</em></span>
        <input type="text" id="f-note" maxlength="${MAX_NOTE_LEN}"
               placeholder="asleep on the blue car" value="${esc(s.note ?? '')}">
      </label>
      <label class="field">
        <span>When</span>
        <input type="datetime-local" id="f-when" value="${esc(localInputValue(s.seenAt))}">
      </label>

      <hr class="rule thin">
      ${pettedRow(draft)}

      <hr class="rule">
      <div class="loc-line">
        <span class="sub" id="loc-line">${esc(accuracyLine(draft))}</span>
      </div>
      <div class="mini-map" id="pin-map"></div>
      <p class="hand">tap or drag to move the pin</p>

      <hr class="rule">
      ${cat === null || cat.sightings.length < 2 ? '' : `
        <button type="button" class="btn-ghost wide" id="split">This is a different cat</button>`}
      <button type="button" class="btn-ghost wide danger" id="del">Delete this photo</button>
      <div style="height:80px"></div>
    </div>

    <!-- Outside .pad, which is the scroll container: a save bar that scrolls away
         mid-decision is the same as not having one. -->
    <div class="save-bar down" id="save-bar">
      <button type="button" class="btn-ghost" id="revert">Undo</button>
      <button type="button" class="btn-stick" id="save">Save changes</button>
    </div>`;

  wire(s, cat);
  drawPinMap(ring);
}

function snapshot(s) {
  return {
    note: s.note ?? null,
    petted: s.petted ?? null,
    seenAt: s.seenAt,
    lat: s.lat,
    lon: s.lon,
    locationSource: s.locationSource,
    accuracyM: s.accuracyM ?? null,
  };
}

function accuracyLine(d) {
  if (d.locationSource === LOCATION_SOURCE.manual) return 'Placed by hand';
  if (d.accuracyM === null) return '';
  return `Accurate to about ${Math.round(d.accuracyM)} m`;
}

/* ── wiring ────────────────────────────────────────────────────────────── */

function markDirty() {
  const bar = $('#save-bar', root);
  if (bar === null) return;
  bar.classList.toggle('down', !dirty());
}

function wire(s, cat) {
  const toCat = $('#to-cat', root);
  if (toCat !== null) toCat.addEventListener('click', () => navigate(`#/cat/${s.catId}`));

  /* The same question as on the cat page, reachable from the map without going via the
   * cat first — it is the photo she is looking at, so it is where she will ask. Offered
   * only when the cat has another photo left; on a lone sighting it would delete the cat
   * and immediately mint an identical one. */
  const splitBtn = $('#split', root);
  if (splitBtn !== null) {
    splitBtn.addEventListener('click', async () => {
      splitBtn.disabled = true;
      splitBtn.textContent = 'moving…';
      try {
        await turnstile.ensurePass();
        const fresh = await splitToNewCat(s.id, cat);
        navigate(`#/cat/${fresh.id}`);
      } catch (err) {
        splitBtn.disabled = false;
        splitBtn.textContent = 'This is a different cat';
        console.error('[sighting] split failed:', err);
      }
    });
  }

  $('#f-note', root).addEventListener('input', (e) => {
    draft.note = e.target.value.trim() === '' ? null : e.target.value.trim();
    markDirty();
  });
  $('#f-when', root).addEventListener('change', (e) => {
    const t = Date.parse(e.target.value);
    // An unparseable date must not silently become "now" — that would rewrite a real
    // capture time with a wrong one and look like it worked.
    if (!Number.isFinite(t)) { e.target.value = localInputValue(draft.seenAt); return; }
    draft.seenAt = t;
    markDirty();
  });

  // Petted saves on the Save button with everything else, not per tap: every PATCH is a
  // D1 write plus an app_meta bump against a hard 100k/day cap.
  wireChips(root, draft, markDirty);

  $('#revert', root).addEventListener('click', () => {
    draft = null;
    original = null;
    render(store.get());
  });
  $('#save', root).addEventListener('click', () => save(s.id));
  $('#del', root).addEventListener('click', () => remove(s.id));

}

function drawPinMap(ring) {
  const el = $('#pin-map', root);
  if (el === null) return;

  const chosen = TILE_SOURCES.find((t) => t.id === getPref(LS.tileSource, DEFAULT_TILE_ID))
    ?? TILE_SOURCES[0];
  miniMap = L.map(el, { preferCanvas: true, attributionControl: false, zoomControl: false })
    .setView([draft.lat, draft.lon], 17);
  L.tileLayer(chosen.url, {
    subdomains: chosen.subdomains ?? 'abc',
    maxZoom: chosen.maxZoom,
    maxNativeZoom: chosen.maxNativeZoom,
  }).addTo(miniMap);

  miniMarker = L.marker([draft.lat, draft.lon], {
    draggable: true,
    icon: L.divIcon({
      className: 'drop-pin', html: `<i style="--ring:${ring}"></i>`,
      iconSize: [26, 34], iconAnchor: [13, 32],
    }),
  }).addTo(miniMap);

  const moved = (lat, lon) => {
    draft.lat = lat;
    draft.lon = lon;
    draft.locationSource = LOCATION_SOURCE.manual;
    // An accuracy radius around a hand-placed pin is a lie, so it goes with the move.
    draft.accuracyM = null;
    $('#loc-line', root).textContent = accuracyLine(draft);
    markDirty();
  };
  miniMarker.on('dragend', () => {
    const p = miniMarker.getLatLng();
    moved(p.lat, p.lng);
  });
  miniMap.on('click', (e) => {
    miniMarker.setLatLng(e.latlng);
    moved(e.latlng.lat, e.latlng.lng);
  });

  unsize = keepSized(miniMap, el);
}

/* ── mutations ─────────────────────────────────────────────────────────── */

async function save(id) {
  if (saving || !dirty()) return;
  saving = true;
  const btn = $('#save', root);
  btn.disabled = true;
  btn.textContent = 'Saving…';
  try {
    await turnstile.ensurePass();
    // Send only what changed: an unchanged field in the body is still a column written.
    const patch = {};
    if (draft.note !== original.note) patch.note = draft.note;
    if (draft.petted !== original.petted) patch.petted = draft.petted;
    if (draft.seenAt !== original.seenAt) patch.seenAt = draft.seenAt;
    if (draft.lat !== original.lat || draft.lon !== original.lon) {
      patch.lat = draft.lat;
      patch.lon = draft.lon;
      patch.locationSource = draft.locationSource;
      patch.accuracyM = draft.accuracyM;
    }
    await patchSighting(id, patch);
    draft = null;
    original = null;
    await store.refresh();
    render(store.get());
  } catch (err) {
    console.error('[sighting] save failed:', err);
    btn.disabled = false;
    btn.textContent = 'Save changes';
    btn.insertAdjacentHTML('afterend', `<div class="map-note">${esc(err.message)}</div>`);
  } finally {
    saving = false;
  }
}

async function remove(id) {
  const btn = $('#del', root);
  if (btn.dataset.armed !== 'true') {
    // Two taps, not a confirm() — the second tap is the confirmation, and a native
    // dialog in a standalone app looks like the browser breaking through.
    btn.dataset.armed = 'true';
    btn.textContent = 'Really delete? Tap again';
    setTimeout(() => {
      if (btn.isConnected) { btn.dataset.armed = 'false'; btn.textContent = 'Delete this sighting'; }
    }, 4000);
    return;
  }
  btn.disabled = true;
  try {
    await turnstile.ensurePass();
    await deleteSighting(id);
    draft = null;
    original = null;
    await store.refresh();
    back();
  } catch (err) {
    console.error('[sighting] delete failed:', err);
    btn.disabled = false;
    btn.textContent = 'Delete this sighting';
  }
}

export function mount(container, arg) {
  root = container;
  sightingId = Number(arg);
  draft = null;
  original = null;
  unsubscribe = store.subscribe(render);
}

export function unmount() {
  if (unsubscribe !== null) { unsubscribe(); unsubscribe = null; }
  if (unsize !== null) { unsize(); unsize = null; }
  if (miniMap !== null) { miniMap.remove(); miniMap = null; miniMarker = null; }
  draft = null;
  original = null;
  root = null;
  sightingId = null;
}
