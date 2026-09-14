import { DEFAULT_TILE_ID, LS, MAX_NAME_LEN, TILE_SOURCES } from '../config.js';
import { createCat, deleteCat, patchCat, patchSighting, photoUrl } from './api.js';
import { catColour, displayName } from './catcolor.js';
import { getPref } from './device.js';
import { $, distanceText, esc, whenText } from './dom.js';
import { distanceM } from './suggest.js';
import { navigate } from './nav.js';
import { turfRing, shouldDrawTurf } from './turf.js';
import * as store from './store.js';
import * as turnstile from './turnstile.js';

/* One cat: rename it, see where it lives, and answer two questions in plain language.
 *
 *   "I've seen this cat before"  → pick another cat's face → the two become one.
 *   "this is a different cat"    → that photo leaves and becomes its own cat.
 *
 * BOTH ARE SINGLE TAPS ON A FACE, and each undoes the other, so there is no sequence to
 * learn and no way to get stuck with a wrong answer. That is the whole design rule for
 * this page: no modes, no multi-select, nothing that can be half-done.
 *
 * Deleting a cat never deletes its photographs — they leave as cats of their own.
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
    root.innerHTML = '<div class="pad"><p class="empty">That cat is not here any more.</p></div>';
    return;
  }

  const colour = catColour(cat.id);
  const sightings = [...cat.sightings].sort((a, b) => b.seenAt - a.seenAt);

  root.innerHTML = `
    <div class="pad" style="--ring:${esc(colour.hex)}">
      <div class="detail-head">
        <h1 class="sec">Edit cat</h1>
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
          <div class="loose-card">
            <button type="button" class="face" data-sighting="${s.id}">
              <img src="${esc(photoUrl(s.photoThumb))}" alt="" crossorigin="anonymous">
            </button>
            <span class="why">${esc(whenText(s.seenAt))}</span>
            ${sightings.length < 2 ? '' : `
              <button type="button" class="btn-ghost sm" data-split="${s.id}">different cat</button>`}
          </div>`).join('')}
      </div>

      <hr class="rule">
      <button type="button" class="btn-stick wide" id="same-as">I&rsquo;ve seen this cat before</button>
      <div id="merge-pick"></div>
      <div class="map-note" id="cat-err" style="position:static"></div>
    </div>`;

  wire(cat);
  if (sightings.length >= 2) drawTerritory(sightings, colour);
}

function wire(cat) {
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

  $('#same-as', root).addEventListener('click', () => showMergePicker(cat));
  for (const btn of root.querySelectorAll('[data-split]')) {
    btn.addEventListener('click', () => split(Number(btn.dataset.split), cat));
  }
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

function fail(err, what) {
  console.error(`[cat] ${what} failed:`, err);
  const note = $('#cat-err', root);
  if (note !== null) note.textContent = err.message;
}

/**
 * "I've seen this cat before" — show every OTHER cat as a face and merge on one tap.
 *
 * Nearest first, because the cat she means is almost always one she photographed near
 * here. No search box, no multi-select, no confirmation: one tap is the whole gesture,
 * and it is undone by tapping "different cat" on the photo that moved.
 */
function showMergePicker(cat) {
  const slot = $('#merge-pick', root);
  const others = store.catsWithSightings()
    .filter((o) => o.id !== cat.id && o.sightings.length > 0);

  if (others.length === 0) {
    slot.innerHTML = '<p class="hand">no other cats yet</p>';
    return;
  }
  const here = cat.sightings[0];
  const near = (o) => Math.min(...o.sightings.map(
    (s) => distanceM(here.lat, here.lon, s.lat, s.lon)));
  others.sort((a, b) => near(a) - near(b));

  slot.innerHTML = `
    <p class="hand">which one is it?</p>
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
    btn.addEventListener('click', () => merge(cat, Number(btn.dataset.merge)));
  }
}

/**
 * Fold this cat into another. The OLDER cat survives, so the one she met first keeps its
 * name and colour whichever way round she taps.
 *
 * Not atomic and cannot be — there is no bulk endpoint — so a part-way failure leaves
 * some photos moved and says so, rather than rolling back and risking undoing a link
 * that did land.
 */
async function merge(cat, otherId) {
  const survivor = Math.min(cat.id, otherId);
  const absorbed = Math.max(cat.id, otherId);
  const btn = $('#same-as', root);
  btn.disabled = true;
  btn.textContent = 'Joining…';
  try {
    await turnstile.ensurePass();
    const doomed = store.catsWithSightings().find((c) => c.id === absorbed);
    for (const s of doomed.sightings) {
      // eslint-disable-next-line no-await-in-loop -- serial; see above
      await patchSighting(s.id, { catId: survivor });
    }
    await deleteCat(absorbed);
    await store.refresh();
    navigate(`#/cat/${survivor}`);
  } catch (err) {
    btn.disabled = false;
    btn.textContent = 'I\u2019ve seen this cat before';
    fail(err, 'merge');
  }
}

/** "different cat" — this photo leaves and becomes a cat of its own. The exact inverse
 *  of a merge, which is what makes every join safely reversible. */
async function split(sightingId, cat) {
  const btn = root.querySelector(`[data-split="${sightingId}"]`);
  if (btn !== null) { btn.disabled = true; btn.textContent = 'moving…'; }
  try {
    await turnstile.ensurePass();
    const { cat: fresh } = await createCat(null, null);
    await patchSighting(sightingId, { catId: fresh.id });
    // The cat this left may now be empty; tidy it up rather than leaving a shell.
    if (cat.sightings.length === 1) await deleteCat(cat.id);
    await store.refresh();
    navigate(`#/cat/${fresh.id}`);
  } catch (err) {
    if (btn !== null) { btn.disabled = false; btn.textContent = 'different cat'; }
    fail(err, 'split');
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
