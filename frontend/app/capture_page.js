import {
  ACCEPT_TYPES, COAT_TAGS, DEFAULT_ZOOM, FALLBACK_CENTRE, MAX_NAME_LEN, MAX_NOTE_LEN,
  PETTED_VALUES, SIZE_TAGS, TILE_SOURCES, DEFAULT_TILE_ID, LS,
} from '../config.js';
import { $, dateText, esc } from './dom.js';
import { catColour, displayName } from './catcolor.js';
import { patchSighting, photoUrl } from './api.js';
import { getPref } from './device.js';
import { startLocating } from './geolocate.js';
import { LOCATION_SOURCE, processPhoto, resolveLocation, resolveSeenAt } from './pipeline.js';
import { reasonText, suggestCats } from './suggest.js';
import * as flush from './flush.js';
import * as pwa from './pwa.js';
import * as store from './store.js';
import * as turnstile from './turnstile.js';

/* Take or choose a photo, place it, tag it, queue it.
 *
 * THE SAVE IS LOCAL. Nothing here awaits the network: the draft goes into the outbox
 * and flush.js takes it from there, so an upload in a dead zone is indistinguishable
 * from one on wifi until the banner says otherwise. That is what makes photographing
 * ten cats in a park with no signal safe.
 */

const PETTED_LABEL = { yes: 'petted it', no: 'did not pet it', fled: 'it fled' };
const CHIP_FILLS = ['var(--marigold)', 'var(--coral)', 'var(--jade)', 'var(--peri)'];
const ON_DARK = new Set(['var(--coral)', 'var(--peri)']);

let root = null;
let draft = null;
let locating = null;     // the in-flight geolocation handle
let miniMap = null;
let miniMarker = null;
let objectUrl = null;

/* ── rendering ─────────────────────────────────────────────────────────── */

function chip(label, value, selected, group, i) {
  const fill = CHIP_FILLS[i % CHIP_FILLS.length];
  const dark = ON_DARK.has(fill) ? ' on-dark' : '';
  const tilt = i % 2 === 0 ? '-2deg' : '1.5deg';
  return `<button type="button" class="chip${dark}" data-group="${esc(group)}"
    data-value="${esc(value)}" aria-pressed="${selected ? 'true' : 'false'}"
    style="--fill:${fill};--tilt:${tilt}">${esc(label)}</button>`;
}

function idleView() {
  return `
    <div class="pad capture-idle">
      <div class="shutter-row">
        <button type="button" class="btn-stick big" id="take">Take a photo</button>
        <button type="button" class="btn-ghost big" id="choose">Choose a photo</button>
      </div>
      <p class="hand arrow-note">a photo from the camera uses where you are right now</p>
      <div id="install-slot"></div>
      <input type="file" id="file-camera" accept="${esc(ACCEPT_TYPES)}"
             capture="environment" hidden>
      <input type="file" id="file-library" accept="${esc(ACCEPT_TYPES)}" hidden>
    </div>`;
}

function busyView(message) {
  return `<div class="pad capture-busy">
    <div class="spinner" role="status" aria-live="polite"></div>
    <p>${esc(message)}</p>
  </div>`;
}

function errorView(message) {
  return `<div class="pad">
    <div class="map-note" style="position:static">${esc(message)}</div>
    <button type="button" class="btn-stick" id="back">Try again</button>
  </div>`;
}

function locationLine() {
  if (draft.lat === null) return 'No location yet — tap the map below';
  if (draft.locationSource === LOCATION_SOURCE.manual) return 'Placed by hand';
  if (draft.accuracyM === null) return 'Located';
  return `Accurate to about ${Math.round(draft.accuracyM)} m`;
}

function draftView() {
  const notice = draft.notice === null ? '' : `<p class="hand notice">${esc(draft.notice)}</p>`;
  return `
    <div class="pad capture-draft">
      <figure class="print">
        <span class="tape" style="top:-11px;left:50%;margin-left:-44px;transform:rotate(-2deg)"></span>
        <img src="${esc(objectUrl)}" alt="The cat you just photographed" style="height:210px">
      </figure>
      ${notice}

      <label class="field">
        <span>Name <em>(optional)</em></span>
        <input type="text" id="f-name" maxlength="${MAX_NAME_LEN}"
               placeholder="leave blank if you don't know" value="${esc(draft.name ?? '')}">
      </label>

      <hr class="rule">
      <div class="chiprow" id="coat-row">
        ${COAT_TAGS.map((t, i) => chip(t, t, draft.coat.includes(t), 'coat', i)).join('')}
      </div>
      <div class="chiprow" id="size-row">
        ${SIZE_TAGS.map((t, i) => chip(t, t, draft.size === t, 'size', i + 1)).join('')}
      </div>
      <div class="chiprow" id="petted-row">
        ${PETTED_VALUES.map((v, i) => chip(PETTED_LABEL[v], v, draft.petted === v, 'petted', i + 2)).join('')}
      </div>

      <hr class="rule">
      <label class="field">
        <span>Note <em>(optional)</em></span>
        <input type="text" id="f-note" maxlength="${MAX_NOTE_LEN}"
               placeholder="asleep on the blue car" value="${esc(draft.note ?? '')}">
      </label>

      <hr class="rule">
      <div class="loc-line">
        <span class="when">${esc(dateText(draft.seenAt))}</span>
        <span class="sub" id="loc-line">${locationLine()}</span>
      </div>
      <div class="mini-map" id="mini-map"></div>
      <p class="hand">tap the map to move the pin</p>

      <div class="save-row">
        <button type="button" class="btn-ghost" id="discard">Discard</button>
        <button type="button" class="btn-stick big" id="save">Save this cat</button>
      </div>
    </div>`;
}

/**
 * The suggestion card. SHOW THE PHOTO BIG and keep the reasoning small: she identifies
 * the cat by looking at it, and the algorithm's only job is to put the right three
 * faces in front of her. Never auto-links.
 */
function suggestionView(candidates, cats) {
  if (candidates.length === 0) {
    return `<div class="pad">
      <p class="saved-note hand">Saved! It is on the map.</p>
      <button type="button" class="btn-stick" id="again">Another cat</button>
    </div>`;
  }
  const now = Date.now();
  return `
    <div class="pad">
      <p class="saved-note hand">Saved! Is this one of these?</p>
      <div class="suggest-row">
        ${candidates.map((score) => {
          const cat = cats.find((c) => c.id === score.catId);
          // Most recent sighting, because that is what she saw most recently.
          const face = cat.sightings.reduce((a, b) => (b.seenAt > a.seenAt ? b : a));
          return `
          <button type="button" class="suggest" data-cat="${cat.id}"
                  style="--ring:${esc(catColour(cat.id))}">
            <img src="${esc(photoUrl(face.photoThumb))}" alt="" crossorigin="anonymous">
            <span class="nm">${esc(displayName(cat))}</span>
            <span class="why">${esc(reasonText(score, now))}</span>
          </button>`;
        }).join('')}
      </div>
      <button type="button" class="btn-ghost" id="again">No, a new cat</button>
    </div>`;
}

/* ── the mini map ──────────────────────────────────────────────────────── */

function mountMiniMap() {
  const el = $('#mini-map', root);
  if (el === null) return;

  const chosen = TILE_SOURCES.find((t) => t.id === getPref(LS.tileSource, DEFAULT_TILE_ID))
    ?? TILE_SOURCES[0];
  const centre = draft.lat === null
    ? [FALLBACK_CENTRE.lat, FALLBACK_CENTRE.lon]
    : [draft.lat, draft.lon];

  miniMap = L.map(el, { preferCanvas: true, attributionControl: false, zoomControl: false })
    .setView(centre, draft.lat === null ? DEFAULT_ZOOM - 2 : 17);
  L.tileLayer(chosen.url, {
    subdomains: chosen.subdomains ?? 'abc',
    maxZoom: chosen.maxZoom,
    maxNativeZoom: chosen.maxNativeZoom,
  }).addTo(miniMap);

  if (draft.lat !== null) placeMarker(draft.lat, draft.lon);

  miniMap.on('click', (e) => {
    draft.lat = e.latlng.lat;
    draft.lon = e.latlng.lng;
    draft.locationSource = LOCATION_SOURCE.manual;
    // An accuracy radius around a pin someone dragged by hand is a lie.
    draft.accuracyM = null;
    placeMarker(draft.lat, draft.lon);
    $('#loc-line', root).textContent = locationLine();
  });

  // The container was written into the DOM a moment ago, so Leaflet measured it at
  // zero height. Without this the tiles render in one corner.
  requestAnimationFrame(() => miniMap.invalidateSize());
}

function placeMarker(lat, lon) {
  if (miniMarker !== null) { miniMarker.setLatLng([lat, lon]); return; }
  miniMarker = L.marker([lat, lon], {
    draggable: true,
    icon: L.divIcon({ className: 'drop-pin', html: '<i></i>', iconSize: [26, 34], iconAnchor: [13, 32] }),
  }).addTo(miniMap);
  miniMarker.on('dragend', () => {
    const p = miniMarker.getLatLng();
    draft.lat = p.lat;
    draft.lon = p.lng;
    draft.locationSource = LOCATION_SOURCE.manual;
    draft.accuracyM = null;
    $('#loc-line', root).textContent = locationLine();
  });
}

function destroyMiniMap() {
  if (miniMap !== null) { miniMap.remove(); miniMap = null; }
  miniMarker = null;
}

/* ── flow ──────────────────────────────────────────────────────────────── */

function releasePhoto() {
  if (objectUrl !== null) { URL.revokeObjectURL(objectUrl); objectUrl = null; }
}

function showIdle() {
  // A watch left running after a discard keeps the GPS radio warm for nothing.
  if (locating !== null) { locating.cancel(); locating = null; }
  destroyMiniMap();
  releasePhoto();
  draft = null;
  root.innerHTML = idleView();
  pwa.maybeOfferInstall($('#install-slot', root));
  wireIdle();
}

function wireIdle() {
  const camera = $('#file-camera', root);
  const library = $('#file-library', root);

  const open = (input, fromCamera) => {
    // The click MUST happen synchronously inside the user gesture — never await before
    // it, or iOS silently drops the picker. Geolocation therefore starts AFTER.
    input.value = '';   // or re-picking the same photo fires no change event at all
    input.click();
    if (locating !== null) locating.cancel();
    locating = startLocating();
    input.onchange = () => {
      const file = input.files?.[0];
      if (file === undefined) return;
      ingest(file, fromCamera);
    };
  };

  $('#take', root).addEventListener('click', () => open(camera, true));
  $('#choose', root).addEventListener('click', () => open(library, false));
}

async function ingest(file, fromCamera) {
  root.innerHTML = busyView('Processing…');
  try {
    const processed = await processPhoto(file);

    // Resolve the fix only now: it has had the whole decode and resize to converge, and
    // a failure here is not fatal — it becomes a manual placement.
    let fix = null;
    if (locating !== null) fix = await locating.result.catch(() => null);

    const now = Date.now();
    const place = resolveLocation(processed.meta, fix, fromCamera, now);

    draft = {
      clientId: crypto.randomUUID(),
      ...processed,
      lat: place.lat,
      lon: place.lon,
      accuracyM: place.accuracyM,
      locationSource: place.source,
      notice: place.notice,
      seenAt: resolveSeenAt(processed.meta, now),
      name: null,
      coat: [],
      size: null,
      petted: null,
      note: null,
    };
    releasePhoto();
    objectUrl = URL.createObjectURL(new Blob([draft.fullBytes], { type: 'image/jpeg' }));

    root.innerHTML = draftView();
    mountMiniMap();
    wireDraft();
  } catch (err) {
    console.error('[capture] ingest failed:', err);
    root.innerHTML = errorView(err.message);
    $('#back', root).addEventListener('click', showIdle);
  } finally {
    if (locating !== null) { locating.cancel(); locating = null; }
  }
}

function wireDraft() {
  for (const row of ['#coat-row', '#size-row', '#petted-row']) {
    $(row, root).addEventListener('click', (e) => {
      const btn = e.target.closest('.chip');
      if (btn === null) return;
      const { group, value } = btn.dataset;
      const on = btn.getAttribute('aria-pressed') === 'true';

      if (group === 'coat') {
        draft.coat = on ? draft.coat.filter((t) => t !== value) : [...draft.coat, value].sort();
        btn.setAttribute('aria-pressed', on ? 'false' : 'true');
        return;
      }
      // size and petted are single-select, and tapping the chosen one clears it
      draft[group] = on ? null : value;
      for (const sib of $(row, root).querySelectorAll('.chip')) {
        sib.setAttribute('aria-pressed', String(!on && sib.dataset.value === value));
      }
    });
  }

  $('#f-name', root).addEventListener('input', (e) => {
    draft.name = e.target.value.trim() === '' ? null : e.target.value.trim();
  });
  $('#f-note', root).addEventListener('input', (e) => {
    draft.note = e.target.value.trim() === '' ? null : e.target.value.trim();
  });

  $('#discard', root).addEventListener('click', showIdle);
  $('#save', root).addEventListener('click', save);
}

async function save() {
  if (draft.lat === null) {
    $('#loc-line', root).textContent = 'Tap the map to place this cat first';
    $('#mini-map', root).scrollIntoView({ behavior: 'smooth', block: 'center' });
    return;
  }
  const btn = $('#save', root);
  btn.disabled = true;

  const saved = draft;
  destroyMiniMap();

  // The pass is fetched BEFORE queueing so the challenge appears while she is still
  // looking at this photo, rather than minutes later from a background flush. A failure
  // is not fatal: the row queues anyway and flush.js retries the exchange.
  await turnstile.ensurePass().catch((err) => console.warn('[capture] pass:', err.message));
  await flush.enqueue(saved);

  const cats = store.catsWithSightings();
  const candidates = suggestCats(saved, cats, Date.now());
  root.innerHTML = suggestionView(candidates, cats);
  releasePhoto();
  draft = null;
  wireSuggestion(saved);
}

async function link(clientId, catId) {
  if (await flush.linkWhenUploaded(clientId, catId)) return;
  const uploaded = store.get().sightings.find((x) => x.clientId === clientId);
  if (uploaded === undefined) throw new Error('That sighting could not be found');
  await patchSighting(uploaded.id, { catId });
  await store.refresh();
}

function wireSuggestion(saved) {
  $('#again', root).addEventListener('click', showIdle);
  for (const btn of root.querySelectorAll('.suggest')) {
    btn.addEventListener('click', () => {
      // A queued row has no server id yet, so the link rides along with the insert.
      // If it already uploaded — a fast connection and a slow tap — patch it instead;
      // silently dropping a link she explicitly made would be the worse failure.
      link(saved.clientId, Number(btn.dataset.cat))
        .then(showIdle)
        .catch((err) => console.error('[capture] link failed:', err));
    });
  }
}

/* ── page contract ─────────────────────────────────────────────────────── */

export function mount(container) {
  root = container;
  showIdle();
}

export function unmount() {
  if (locating !== null) { locating.cancel(); locating = null; }
  destroyMiniMap();
  releasePhoto();
  draft = null;
  root = null;
}
