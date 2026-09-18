import {
  DEFAULT_TILE_ID, LS, MAX_NAME_LEN, MAX_NOTE_LEN, TILE_SOURCES,
} from '../config.js';
import { deleteSighting, patchCat, patchSighting, photoUrl } from './api.js';
import { catColour, displayName, inkFor } from './catcolor.js';
import { chipRows, pettedRow, wireChips } from './components/chips.js';
import { frame } from './components/filmstrip.js';
import { getPref } from './device.js';
import { $, distanceText, esc } from './dom.js';
import { back, navigate } from './nav.js';
import { LOCATION_SOURCE } from './pipeline.js';
import { distanceM } from './suggest.js';
import { mergeCats, splitToNewCat } from './identity.js';
import { keepSized } from './minimap.js';
import * as store from './store.js';
import * as turnstile from './turnstile.js';

/* ONE PHOTOGRAPH, AND THE ONLY EDITOR IN THE APP.
 *
 * It used to be half an editor. Coat, size, name and grouping lived in an edit mode on
 * the cat page; date, place, note and petted lived here. Two screens, two layouts, two
 * save models — a debounce there and a Save bar here — and no way to tell from either one
 * which half of a cat you were allowed to change. Both Edit buttons now land here, opened
 * on the photo she was looking at, and everything about that photo and its cat is on this
 * one page in one order: who they are, then what happened in this picture, then where.
 *
 * THE TWO HALVES ARE STILL TWO ROWS IN D1 and the page never pretends otherwise:
 *
 *   the CAT      name, coat, size   — true of the animal, shared by all its photos
 *   the SIGHTING petted, note, when, where — true of this encounter only
 *
 * Coat and size genuinely cannot differ between encounters without one of them being
 * wrong. Petted genuinely can, which is why 004 moved it back onto the sighting, and it
 * is drawn on this print rather than on all of them. Save sends at most one PATCH to each
 * and only the fields that actually changed — every one is a D1 write plus an app_meta
 * bump against a hard 100k/day cap.
 *
 * EDITS ARE EXPLICIT, NOT LIVE. A chip row is very easy to fiddle with and autosaving
 * each tap would turn one decision into eight writes, so changes accumulate locally and
 * the Save bar rises once something actually differs.
 *
 * `location_source` is stored but never displayed. Brennan: "if its just the source of
 * the data then not required, store it, but dont display" — the only thing worth
 * surfacing is the accuracy, and only when it is bad enough to matter.
 */

let root = null;
let sightingId = null;
let unsubscribe = null;
let draft = null;        // this photo's working copy; null means "showing server state"
let original = null;
let catDraft = null;     // the animal's working copy; null when the cat is not loaded
let catOriginal = null;
let miniMap = null;
let miniMarker = null;
let unsize = null;
let saving = false;

function dirty() {
  if (draft === null || original === null) return false;
  const photo = draft.note !== original.note
    || draft.seenAt !== original.seenAt
    || draft.petted !== original.petted
    || draft.lat !== original.lat
    || draft.lon !== original.lon;
  if (catDraft === null) return photo;
  return photo
    || catDraft.name !== catOriginal.name
    || catDraft.coat.join(',') !== catOriginal.coat.join(',')
    || catDraft.size !== catOriginal.size;
}

/** `<input type="datetime-local">` wants local wall time with no zone suffix. */
function localInputValue(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
    + `T${pad(d.getHours())}:${pad(d.getMinutes())}`;
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

function catSnapshot(cat) {
  if (cat === null) return null;
  return { name: cat.name ?? null, coat: [...cat.coat], size: cat.size };
}

function accuracyLine(d) {
  if (d.locationSource === LOCATION_SOURCE.manual) return 'Placed by hand';
  if (d.accuracyM === null) return '';
  return `Accurate to about ${Math.round(d.accuracyM)} m`;
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

  /* WITH its sightings: the split needs to know whether this is the cat's only photo, and
   * the new cat inherits this one's description. */
  const cat = store.catsWithSightings(state).find((c) => c.id === s.catId) ?? null;
  const colour = catColour(s.catId);
  const ring = colour === null ? 'var(--rule)' : colour.hex;

  original = snapshot(s);
  draft = snapshot(s);
  catOriginal = catSnapshot(cat);
  catDraft = catSnapshot(cat);

  root.innerHTML = `
    <div class="pad" style="--ring:${esc(ring)};--ring-ink:${esc(inkFor(s.catId))}">
      <!-- BLANK FILM. The glance draws the name, date and petted stamp ON the print; here
           they are all editable below, and a mark that cannot update until Save would be
           contradicting the field two inches under it. -->
      ${frame(s, {
        name: cat === null ? 'this cat' : displayName(cat),
        src: (x) => photoUrl(x.photoFull),
        editing: true,
      })}

      ${cat === null ? '' : `
        <hr class="rule">
        <h2 class="sec">Who they are</h2>
        <label class="field">
          <span>Name <em>(optional)</em></span>
          <input type="text" id="f-name" maxlength="${MAX_NAME_LEN}"
                 placeholder="leave blank if you don&rsquo;t know"
                 value="${esc(cat.name ?? '')}">
        </label>
        <div id="cat-chips">${chipRows(catDraft)}</div>`}

      <hr class="rule">
      <h2 class="sec">This photo</h2>
      <div id="photo-chips">${pettedRow(draft)}</div>
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
      <div class="loc-line">
        <span class="sub" id="loc-line">${esc(accuracyLine(draft))}</span>
      </div>
      <div class="mini-map" id="pin-map"></div>
      <p class="hand">tap or drag to move the pin</p>

      <hr class="rule">
      ${cat === null ? '' : `
        <button type="button" class="btn-stick wide" id="same-as">I&rsquo;ve seen this cat before</button>
        <div id="merge-pick"></div>`}
      ${cat === null || cat.sightings.length < 2 ? '' : `
        <button type="button" class="btn-ghost wide" id="split">This photo is a different cat</button>`}
      <button type="button" class="btn-ghost wide danger" id="del">Delete this photo</button>
      <div class="map-note" id="edit-err" style="position:static"></div>
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

/* ── wiring ────────────────────────────────────────────────────────────── */

function markDirty() {
  const bar = $('#save-bar', root);
  if (bar === null) return;
  bar.classList.toggle('down', !dirty());
}

function fail(err, what) {
  console.error(`[sighting] ${what} failed:`, err);
  const note = $('#edit-err', root);
  if (note !== null) note.textContent = err.message;
}

function wire(s, cat) {
  /* TWO DRAFTS, TWO ROOTS. wireChips writes straight into the object it is given, so the
   * rows that describe the animal and the row that describes this photo have to be wired
   * separately or one would be writing coat tags onto the sighting. */
  if (cat !== null) {
    $('#f-name', root).addEventListener('input', (e) => {
      catDraft.name = e.target.value.trim() === '' ? null : e.target.value.trim();
      markDirty();
    });
    wireChips($('#cat-chips', root), catDraft, markDirty);
  }
  wireChips($('#photo-chips', root), draft, markDirty);

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

  $('#revert', root).addEventListener('click', () => {
    draft = null;
    original = null;
    catDraft = null;
    catOriginal = null;
    render(store.get());
  });
  $('#save', root).addEventListener('click', () => save(s, cat));
  $('#del', root).addEventListener('click', () => remove(s.id));

  if (cat !== null) {
    $('#same-as', root).addEventListener('click', () => showMergePicker(s, cat));
  }
  const splitBtn = $('#split', root);
  if (splitBtn !== null) splitBtn.addEventListener('click', () => split(s, cat));
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

/**
 * Send whatever actually differs, at most one PATCH per row.
 *
 * Shared by the Save button and by the two identity actions, which call it FIRST: merging
 * or splitting re-reads the cat from the server, so anything she had typed and not saved
 * would be silently binned by a tap that looks unrelated to it.
 */
async function applyEdits(s, cat) {
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
  if (Object.keys(patch).length > 0) await patchSighting(s.id, patch);

  if (cat === null) return;
  const catPatch = {};
  if (catDraft.name !== catOriginal.name) catPatch.name = catDraft.name;
  if (catDraft.coat.join(',') !== catOriginal.coat.join(',')) catPatch.coat = catDraft.coat;
  if (catDraft.size !== catOriginal.size) catPatch.size = catDraft.size;
  if (Object.keys(catPatch).length > 0) await patchCat(cat.id, catPatch);
}

async function save(s, cat) {
  if (saving || !dirty()) return;
  saving = true;
  const btn = $('#save', root);
  btn.disabled = true;
  btn.textContent = 'Saving…';
  try {
    await turnstile.ensurePass();
    await applyEdits(s, cat);
    draft = null;
    original = null;
    await store.refresh();
    render(store.get());
  } catch (err) {
    btn.disabled = false;
    btn.textContent = 'Save changes';
    fail(err, 'save');
  } finally {
    saving = false;
  }
}

/**
 * "I've seen this cat before" — show every OTHER cat as a face and merge on one tap.
 *
 * Nearest first, because the cat she means is almost always one she photographed near
 * here. No search box, no multi-select, no confirmation: one tap is the whole gesture,
 * and it is undone by tapping "this photo is a different cat".
 */
function showMergePicker(s, cat) {
  const slot = $('#merge-pick', root);
  const others = store.catsWithSightings()
    .filter((o) => o.id !== cat.id && o.sightings.length > 0);

  if (others.length === 0) {
    slot.innerHTML = '<p class="hand">no other cats yet</p>';
    return;
  }
  const near = (o) => Math.min(...o.sightings.map(
    (x) => distanceM(s.lat, s.lon, x.lat, x.lon)));
  others.sort((a, b) => near(a) - near(b));

  slot.innerHTML = `
    <p class="hand">which one are they?</p>
    <div class="suggest-row">
      ${others.map((o) => {
        const face = o.sightings.reduce((a, b) => (b.seenAt > a.seenAt ? b : a));
        return `
        <button type="button" class="suggest" data-merge="${o.id}"
                style="--ring:${esc(catColour(o.id).hex)}">
          <img src="${esc(photoUrl(face.photoThumb))}" alt="" crossorigin="anonymous">
          <span class="nm">${esc(displayName(o))}</span>
          <span class="why">${esc(distanceText(near(o)))} away</span>
        </button>`;
      }).join('')}
    </div>`;

  for (const btn of slot.querySelectorAll('[data-merge]')) {
    btn.addEventListener('click', () => merge(s, cat, Number(btn.dataset.merge)));
  }
  /* Scroll the faces into view. Revealing UI below the fold and leaving the page where it
   * was reads as the button having done nothing. rAF so the row has laid out first, and
   * 'nearest' so it moves the minimum needed rather than yanking the page. */
  requestAnimationFrame(() => slot.scrollIntoView({ behavior: 'smooth', block: 'nearest' }));
}

async function merge(s, cat, otherId) {
  const btn = $('#same-as', root);
  btn.disabled = true;
  btn.textContent = 'Joining…';
  try {
    await turnstile.ensurePass();
    await applyEdits(s, cat);
    const survivorId = await mergeCats(cat.id, otherId);
    navigate(`#/cat/${survivorId}`);
  } catch (err) {
    btn.disabled = false;
    btn.textContent = 'I’ve seen this cat before';
    fail(err, 'merge');
  }
}

/** "a different cat" — this photo leaves and becomes a cat of its own. The exact inverse
 *  of a merge, which is what makes every join safely reversible. */
async function split(s, cat) {
  const btn = $('#split', root);
  btn.disabled = true;
  btn.textContent = 'moving…';
  try {
    await turnstile.ensurePass();
    await applyEdits(s, cat);
    const fresh = await splitToNewCat(s.id, cat);
    navigate(`#/cat/${fresh.id}`);
  } catch (err) {
    btn.disabled = false;
    btn.textContent = 'This photo is a different cat';
    fail(err, 'split');
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
      if (btn.isConnected) { btn.dataset.armed = 'false'; btn.textContent = 'Delete this photo'; }
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
    btn.disabled = false;
    btn.textContent = 'Delete this photo';
    fail(err, 'delete');
  }
}

export function mount(container, arg) {
  root = container;
  sightingId = Number(arg);
  draft = null;
  original = null;
  catDraft = null;
  catOriginal = null;
  unsubscribe = store.subscribe(render);
}

export function unmount() {
  if (unsubscribe !== null) { unsubscribe(); unsubscribe = null; }
  if (unsize !== null) { unsize(); unsize = null; }
  if (miniMap !== null) { miniMap.remove(); miniMap = null; miniMarker = null; }
  draft = null;
  original = null;
  catDraft = null;
  catOriginal = null;
  root = null;
  sightingId = null;
}
