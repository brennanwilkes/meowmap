import {
  ACCEPT_TYPES, DEFAULT_ZOOM, FALLBACK_CENTRE, MAX_NAME_LEN, MAX_NOTE_LEN,
  TILE_SOURCES, DEFAULT_TILE_ID, LS,
} from '../config.js';
import { $, dateText, distanceText, esc } from './dom.js';
import { catColour, displayName } from './catcolor.js';
import { patchSighting, photoUrl } from './api.js';
import { getPref } from './device.js';
import { startLocating } from './geolocate.js';
import { LOCATION_SOURCE, processPhoto, resolveLocation, resolveSeenAt } from './pipeline.js';
import { distanceM, reasonText, suggestCats } from './suggest.js';
import { chipRows, wireChips } from './components/chips.js';
import * as flush from './flush.js';
import * as pwa from './pwa.js';
import { keepSized } from './minimap.js';
import * as store from './store.js';
import * as turnstile from './turnstile.js';

/* Take or choose a photo, place it, tag it, queue it.
 *
 * THE SAVE IS LOCAL. Nothing here awaits the network: the draft goes into the outbox
 * and flush.js takes it from there, so an upload in a dead zone is indistinguishable
 * from one on wifi until the banner says otherwise. That is what makes photographing
 * ten cats in a park with no signal safe.
 */

let root = null;
let draft = null;
let locating = null;     // the in-flight geolocation handle
let miniMap = null;
let miniMarker = null;
let unsize = null;
let objectUrl = null;

/* ── rendering ─────────────────────────────────────────────────────────── */

function idleView() {
  return `
    <div class="pad capture-idle">
      <div class="shutter-row">
        <button type="button" class="btn-stick big" id="take">Take a photo</button>
        <button type="button" class="btn-ghost big" id="choose">Choose a photo</button>
      </div>
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

/* Two mutually exclusive answers to "who is this", and she can switch between them
 * freely before saving. Grouping first means she never has to re-describe a cat the app
 * already knows, and never ends up with two half-tagged copies of one animal. */
function newCatFields() {
  return `
      <button type="button" class="btn-ghost wide" id="seen-before">I&rsquo;ve seen this cat before</button>
      <div id="pick"></div>

      <label class="field">
        <span>Name <em>(optional)</em></span>
        <input type="text" id="f-name" maxlength="${MAX_NAME_LEN}"
               placeholder="leave blank if you don't know" value="${esc(draft.name ?? '')}">
      </label>

      <hr class="rule">
      ${chipRows(draft)}`;
}

/** Already answered: show WHICH cat, and nothing she could contradict it with. The tags
 *  are the cat's own, so they are shown rather than offered — editing them here would
 *  rewrite that cat's history from a screen that never showed her the old values. */
function groupedPanel() {
  const cat = store.catsWithSightings().find((c) => c.id === draft.catId);
  if (cat === undefined) throw new Error(`grouped onto a cat that is not in the store: ${draft.catId}`);
  const tags = [...cat.coat, cat.size].filter((t) => t !== null && t !== undefined);
  return `
      <div class="grouped" style="--ring:${esc(catColour(cat.id))}">
        <span class="nm">${esc(displayName(cat))}</span>
        ${tags.length === 0 ? '' : `<span class="why">${esc(tags.join(' · '))}</span>`}
      </div>
      <button type="button" class="btn-ghost wide" id="ungroup">No, this is a different cat</button>`;
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

      ${draft.catId === null ? newCatFields() : groupedPanel()}

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
      <p class="saved-note hand">Saved! They&rsquo;re on the map.</p>
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
  unsize = keepSized(miniMap, el);
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
  if (unsize !== null) { unsize(); unsize = null; }
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
      // Set only when she answers "I've seen this cat before" BEFORE saving. Non-null
      // means the tags below belong to that cat and are not hers to set here.
      catId: null,
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
  $('#f-note', root).addEventListener('input', (e) => {
    draft.note = e.target.value.trim() === '' ? null : e.target.value.trim();
  });
  $('#discard', root).addEventListener('click', showIdle);
  $('#save', root).addEventListener('click', save);

  if (draft.catId === null) {
    wireChips(root, draft, () => {});
    $('#f-name', root).addEventListener('input', (e) => {
      draft.name = e.target.value.trim() === '' ? null : e.target.value.trim();
    });
    $('#seen-before', root).addEventListener('click', showPicker);
  } else {
    $('#ungroup', root).addEventListener('click', () => regroup(null));
  }
}

/**
 * Every cat she already has, nearest first, as faces.
 *
 * ONE TAP, on a face. Nearest first because the cat she means is almost always one she
 * photographed near here, and there is no search box, no multi-select and no
 * confirmation — the same rule as the cat page, and the exact inverse of the button
 * that undoes it.
 */
function showPicker() {
  const cats = store.catsWithSightings().filter((c) => c.sightings.length > 0);
  const pick = $('#pick', root);

  if (cats.length === 0) {
    pick.innerHTML = '<p class="hand">No other cats yet — this one is the first.</p>';
    return;
  }

  // Sorted, never cut: a cat two streets away is still one she might mean, and hiding it
  // would leave her with no way to say so.
  const near = cats.map((cat) => ({
    cat,
    metres: draft.lat === null ? Infinity : Math.min(
      ...cat.sightings.map((x) => distanceM(draft.lat, draft.lon, x.lat, x.lon)),
    ),
  })).sort((a, b) => a.metres - b.metres || a.cat.id - b.cat.id);

  pick.innerHTML = `
    <div class="suggest-row">
      ${near.map(({ cat, metres }) => {
        const face = cat.sightings.reduce((a, b) => (b.seenAt > a.seenAt ? b : a));
        return `
        <button type="button" class="suggest" data-pick="${cat.id}"
                style="--ring:${esc(catColour(cat.id))}">
          <img src="${esc(photoUrl(face.photoThumb))}" alt="" crossorigin="anonymous">
          <span class="nm">${esc(displayName(cat))}</span>
          <span class="why">${esc(Number.isFinite(metres) ? distanceText(metres) : '')}</span>
        </button>`;
      }).join('')}
    </div>`;

  for (const btn of pick.querySelectorAll('[data-pick]')) {
    btn.addEventListener('click', () => regroup(Number(btn.dataset.pick)));
  }
  // Revealing faces below the fold and leaving the page put reads as nothing happening.
  requestAnimationFrame(() => pick.scrollIntoView({ behavior: 'smooth', block: 'nearest' }));
}

/** Switch between "a new cat" and "that cat" and back. Nothing is saved yet, so this is
 *  pure local state and costs no request either way. */
function regroup(catId) {
  draft.catId = catId;
  destroyMiniMap();
  root.innerHTML = draftView();
  mountMiniMap();
  wireDraft();
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

  releasePhoto();
  draft = null;

  /* She already said which cat this is, so do not ask again. Offering the same question
   * twice in a row is how a simple screen starts to feel like it has a right answer she
   * might have missed. */
  if (saved.catId !== null) {
    root.innerHTML = `<div class="pad">
      <p class="saved-note hand">Saved! They&rsquo;re on the map.</p>
      <button type="button" class="btn-stick" id="again">Another cat</button>
    </div>`;
    $('#again', root).addEventListener('click', showIdle);
    return;
  }

  const cats = store.catsWithSightings();
  const candidates = suggestCats(saved, cats, Date.now());
  root.innerHTML = suggestionView(candidates, cats);
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
