import { DEFAULT_TILE_ID, LS, MAX_NAME_LEN, TILE_SOURCES } from '../config.js';
import { deleteCat, patchCat, patchSighting, photoUrl } from './api.js';
import { catColour, displayName } from './catcolor.js';
import { getPref } from './device.js';
import { $, esc, whenText } from './dom.js';
import { back, navigate } from './nav.js';
import { turfRing, shouldDrawTurf } from './turf.js';
import * as store from './store.js';
import * as turnstile from './turnstile.js';

/* One cat: rename, its sightings, its territory, and splitting a sighting back out.
 *
 * DELETING A CAT DOES NOT DELETE ITS SIGHTINGS — they revert to unidentified. The
 * grouping is a label, and removing a label must never destroy the photographs it was
 * attached to.
 */

let root = null;
let catId = null;
let unsubscribe = null;
let miniMap = null;
let saveTimer = null;

function render(state) {
  // The store fires on every refresh, including the one this page triggers after a
  // rename. Re-rendering mid-edit would steal focus and drop what she is typing, so
  // the only safe moment to rebuild is when the name field is not being used.
  const input = $('#f-name', root);
  if (input !== null && document.activeElement === input) return;
  if (miniMap !== null) { miniMap.remove(); miniMap = null; }

  const cat = store.catsWithSightings(state).find((c) => c.id === catId);
  if (cat === undefined) {
    root.innerHTML = `<div class="pad">
      <p class="empty">That cat is not here any more.</p>
      <button type="button" class="btn-stick" id="back">Back</button></div>`;
    $('#back', root).addEventListener('click', () => back('#/cats'));
    return;
  }

  const colour = catColour(cat.id);
  const sightings = [...cat.sightings].sort((a, b) => b.seenAt - a.seenAt);

  root.innerHTML = `
    <div class="pad" style="--ring:${esc(colour.hex)}">
      <div class="detail-head">
        <button type="button" class="btn-ghost" id="back">Back</button>
        <span class="swatch" aria-hidden="true"></span>
      </div>

      <label class="field">
        <span>Name <em>(optional)</em></span>
        <input type="text" id="f-name" maxlength="${MAX_NAME_LEN}"
               placeholder="${esc(displayName(cat))}" value="${esc(cat.name ?? '')}">
      </label>
      <p class="hand" id="save-state">&nbsp;</p>

      <hr class="rule">
      <h2 class="sec">${sightings.length === 1 ? 'Seen once' : `Seen ${sightings.length} times`}</h2>
      ${sightings.length < 2 ? '' : '<div class="mini-map" id="cat-map"></div>'}

      <div class="loose-grid">
        ${sightings.map((s) => `
          <button type="button" class="loose-card" data-sighting="${s.id}">
            <img src="${esc(photoUrl(s.photoThumb))}" alt="" crossorigin="anonymous">
            <span class="why">${esc(whenText(s.seenAt))}</span>
          </button>`).join('')}
      </div>

      <hr class="rule">
      <button type="button" class="btn-ghost danger" id="ungroup">
        Not one cat after all
      </button>
      <p class="hand">the photos stay, they just go back to unidentified</p>
    </div>`;

  wire(cat);
  if (sightings.length >= 2) drawTerritory(sightings, colour);
}

function wire(cat) {
  $('#back', root).addEventListener('click', () => back('#/cats'));

  for (const btn of root.querySelectorAll('[data-sighting]')) {
    btn.addEventListener('click', () => navigate(`#/sighting/${btn.dataset.sighting}`));
  }

  const input = $('#f-name', root);
  input.addEventListener('input', () => {
    // Debounced rather than saved per keystroke: every PATCH is a D1 write plus an
    // app_meta bump, and typing "Mochi" would otherwise cost ten of them.
    if (saveTimer !== null) clearTimeout(saveTimer);
    $('#save-state', root).textContent = '';
    saveTimer = setTimeout(() => saveName(cat.id, input.value), 900);
  });

  $('#ungroup', root).addEventListener('click', () => ungroup(cat));
}

async function saveName(id, raw) {
  saveTimer = null;
  const name = raw.trim() === '' ? null : raw.trim();
  const note = $('#save-state', root);
  if (note === null) return;             // the page was closed mid-debounce
  note.textContent = 'saving…';
  try {
    await turnstile.ensurePass();
    await patchCat(id, { name });
    await store.refresh();
    const after = $('#save-state', root);
    if (after !== null) after.textContent = 'saved';
  } catch (err) {
    const after = $('#save-state', root);
    if (after !== null) after.textContent = `not saved — ${err.message}`;
  }
}

/**
 * Undo the grouping. Unlinks every sighting first, then removes the cat — that order
 * means a failure part-way leaves loose sightings and an empty cat, which is harmless
 * and visible. The other order would orphan sightings against a cat that no longer
 * exists.
 */
async function ungroup(cat) {
  const btn = $('#ungroup', root);
  btn.disabled = true;
  btn.textContent = 'Ungrouping…';
  try {
    await turnstile.ensurePass();
    for (const s of cat.sightings) {
      // eslint-disable-next-line no-await-in-loop -- serial, and order matters here
      await patchSighting(s.id, { catId: null });
    }
    await deleteCat(cat.id);
    await store.refresh();
    back('#/cats');
  } catch (err) {
    console.error('[cat] ungroup failed:', err);
    btn.disabled = false;
    btn.textContent = 'Not one cat after all';
    btn.insertAdjacentHTML('afterend', `<div class="map-note">${esc(err.message)}</div>`);
  }
}

function drawTerritory(sightings, colour) {
  const el = $('#cat-map', root);
  if (el === null) return;

  const chosen = TILE_SOURCES.find((t) => t.id === getPref(LS.tileSource, DEFAULT_TILE_ID))
    ?? TILE_SOURCES[0];

  miniMap = L.map(el, { preferCanvas: true, attributionControl: false, zoomControl: false });
  L.tileLayer(chosen.url, {
    subdomains: chosen.subdomains ?? 'abc',
    maxZoom: chosen.maxZoom,
    maxNativeZoom: chosen.maxNativeZoom,
  }).addTo(miniMap);

  const points = sightings.map((s) => [s.lat, s.lon]);
  if (shouldDrawTurf(sightings.length)) {
    L.polygon(turfRing(points), {
      color: colour.hex, weight: 2, opacity: .85, fillColor: colour.hex, fillOpacity: .17,
      dashArray: '7 5', interactive: false,
    }).addTo(miniMap);
  } else {
    L.polyline(points, { color: colour.hex, weight: 2, dashArray: '6 6', interactive: false })
      .addTo(miniMap);
  }
  for (const s of sightings) {
    L.circleMarker([s.lat, s.lon], {
      radius: 5, color: '#2e2a24', weight: 2, fillColor: colour.hex, fillOpacity: 1,
    }).addTo(miniMap);
  }
  miniMap.fitBounds(L.latLngBounds(points).pad(0.35));
  requestAnimationFrame(() => miniMap.invalidateSize());
}

export function mount(container, arg) {
  root = container;
  catId = Number(arg);
  unsubscribe = store.subscribe(render);
}

export function unmount() {
  if (unsubscribe !== null) { unsubscribe(); unsubscribe = null; }
  if (saveTimer !== null) { clearTimeout(saveTimer); saveTimer = null; }
  if (miniMap !== null) { miniMap.remove(); miniMap = null; }
  root = null;
  catId = null;
}
