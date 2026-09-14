import { DEFAULT_TILE_ID, LS, MAX_NAME_LEN, TILE_SOURCES } from '../config.js';
import { createCat, deleteCat, patchCat, patchSighting, photoUrl } from './api.js';
import { catColour, displayName, inkFor } from './catcolor.js';
import { chipRows, wireChips } from './components/chips.js';
import { getPref } from './device.js';
import { $, distanceText, esc, whenText } from './dom.js';
import { distanceM } from './suggest.js';
import { navigate } from './nav.js';
import { turfRing, shouldDrawTurf } from './turf.js';
import * as store from './store.js';
import * as turnstile from './turnstile.js';

/* One cat: everything true of the ANIMAL, plus where it lives and two questions in
 * plain language.
 *
 * Name, coat, size and petted all live here since migration 003. They describe the cat,
 * not any one photograph, so a grouped cat has ONE answer to "what colour is it" instead
 * of one per sighting that could disagree with each other. Date and location belong to
 * the individual photo and are edited by tapping it.
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
/* The working copy of everything that describes the animal. Chips mutate it in place and
 * one debounced PATCH sends whatever actually differs. `pendingFor` is the cat that
 * debounce belongs to, so unmount can flush it without the DOM. */
let edit = null;
let pendingFor = null;

function render(state) {
  // The store fires on every refresh, including the one this page triggers after a
  // rename. Re-rendering mid-edit would steal focus and drop what she is typing, so
  // the only safe moment to rebuild is when the name field is not being used.
  const input = $('#f-name', root);
  if (input !== null && document.activeElement === input) return;
  // A pending debounce means a tap she has made is not on the server yet; rebuilding
  // from server state would silently undo it in front of her.
  if (saveTimer !== null) return;
  if (miniMap !== null) { miniMap.remove(); miniMap = null; }

  const cat = store.catsWithSightings(state).find((c) => c.id === catId);
  if (cat === undefined) {
    root.innerHTML = '<div class="pad"><p class="empty">That cat is not here any more.</p></div>';
    return;
  }

  const colour = catColour(cat.id);
  const sightings = [...cat.sightings].sort((a, b) => b.seenAt - a.seenAt);

  root.innerHTML = `
    <div class="pad" style="--ring:${esc(colour.hex)};--ring-ink:${esc(inkFor(cat.id))}">
      <div class="detail-head">
        <h1 class="sec">Edit cat</h1>
        <span class="swatch" aria-hidden="true"></span>
      </div>

      <div class="plate-wrap">
        <input type="text" class="nameplate" id="f-name" maxlength="${MAX_NAME_LEN}"
               aria-label="This cat's name"
               placeholder="${esc(displayName(cat))}" value="${esc(cat.name ?? '')}">
      </div>
      <p class="hand" id="save-state">&nbsp;</p>

      <hr class="rule">
      ${chipRows(cat)}

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

  edit = { name: cat.name ?? null, coat: [...cat.coat], size: cat.size, petted: cat.petted };
  wire(cat);
  if (sightings.length >= 2) drawTerritory(sightings, colour);
}

function wire(cat) {
  for (const btn of root.querySelectorAll('[data-sighting]')) {
    btn.addEventListener('click', () => navigate(`#/sighting/${btn.dataset.sighting}`));
  }

  const input = $('#f-name', root);
  input.addEventListener('input', () => {
    edit.name = input.value.trim() === '' ? null : input.value.trim();
    schedule(cat);
  });

  /* Tags save on the same debounce as the name rather than behind a Save button. There
   * is no button on this page and adding one for half the fields would be worse than
   * either extreme — and the debounce already collapses a flurry of taps into ONE D1
   * write, which is what the button existed to protect. */
  wireChips(root, edit, () => schedule(cat));

  $('#same-as', root).addEventListener('click', () => showMergePicker(cat));
  for (const btn of root.querySelectorAll('[data-split]')) {
    btn.addEventListener('click', () => split(Number(btn.dataset.split), cat));
  }
}

/** Debounced rather than saved per keystroke or per tap: every PATCH is a D1 write plus
 *  an app_meta bump, and typing "Mochi" would otherwise cost ten of them. */
function schedule(cat) {
  if (saveTimer !== null) clearTimeout(saveTimer);
  pendingFor = cat;
  const note = $('#save-state', root);
  if (note !== null) note.textContent = '';
  saveTimer = setTimeout(() => saveEdits(cat), 900);
}

/** `note` is null once the page has closed; the PATCH still has to go. */
function state(text) {
  if (root === null) return;
  const note = $('#save-state', root);
  if (note !== null) note.textContent = text;
}

async function saveEdits(cat) {
  saveTimer = null;
  pendingFor = null;

  // Send only what changed: an unchanged field in the body is still a column written.
  const patch = {};
  if (edit.name !== (cat.name ?? null)) patch.name = edit.name;
  if (edit.coat.join(',') !== cat.coat.join(',')) patch.coat = edit.coat;
  if (edit.size !== cat.size) patch.size = edit.size;
  if (edit.petted !== cat.petted) patch.petted = edit.petted;
  if (Object.keys(patch).length === 0) { state(''); return; }

  state('saving…');
  try {
    await turnstile.ensurePass();
    await patchCat(cat.id, patch);
    await store.refresh();
    state('saved');
  } catch (err) {
    // The page may already be gone, so this has to be visible in the console too.
    console.error('[cat] save failed:', err);
    state(`not saved — ${err.message}`);
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
/** Newest sighting, or -Infinity for a cat with none. */
function newestAt(cat) {
  return cat.sightings.reduce((a, s) => Math.max(a, s.seenAt), -Infinity);
}

/**
 * Two cats become one, and their descriptions have to become one too.
 *
 * COAT UNIONS; size and petted take the more recently seen cat's answer. A union loses
 * nothing — a cat tagged "orange" here and "tabby" there is an orange tabby, and
 * discarding half would quietly delete something she typed. Size and petted cannot union
 * (a cat is not both a kitten and a chonk), so the newer observation wins as the more
 * likely to still be true; the older one is kept only where the newer has no answer.
 */
function mergeTags(survivor, absorbed) {
  const [newer, older] = newestAt(survivor) >= newestAt(absorbed)
    ? [survivor, absorbed] : [absorbed, survivor];
  return {
    coat: [...new Set([...survivor.coat, ...absorbed.coat])].sort(),
    size: newer.size ?? older.size,
    petted: newer.petted ?? older.petted,
    // Whichever way round she taps, the cat she met first keeps its name.
    name: survivor.name ?? absorbed.name,
  };
}

async function merge(cat, otherId) {
  const survivorId = Math.min(cat.id, otherId);
  const absorbed = Math.max(cat.id, otherId);
  const btn = $('#same-as', root);
  btn.disabled = true;
  btn.textContent = 'Joining…';
  try {
    await turnstile.ensurePass();
    const all = store.catsWithSightings();
    const doomed = all.find((c) => c.id === absorbed);
    const keeper = all.find((c) => c.id === survivorId);
    if (doomed === undefined || keeper === undefined) {
      throw new Error('one of those cats is no longer here');
    }
    await patchCat(survivorId, mergeTags(keeper, doomed));
    for (const s of doomed.sightings) {
      // eslint-disable-next-line no-await-in-loop -- serial; see above
      await patchSighting(s.id, { catId: survivorId });
    }
    await deleteCat(absorbed);
    await store.refresh();
    navigate(`#/cat/${survivorId}`);
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
    /* The new cat inherits the description it is leaving. She grouped these in the first
     * place because they looked alike, so an orange tabby splitting off is still an
     * orange tabby — starting it blank would make her re-type what she already knows. */
    const { cat: fresh } = await createCat({ coat: cat.coat, size: cat.size, petted: cat.petted });
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
  /* FLUSH, never drop. Swiping the sheet away within the debounce window used to bin the
   * edit silently — she taps "chonk", leaves, and it was never saved. The PATCH is fired
   * without awaiting it: unmount cannot be async, and the request outlives this page. */
  if (saveTimer !== null) {
    clearTimeout(saveTimer);
    saveTimer = null;
    if (pendingFor !== null) saveEdits(pendingFor);
  }
  if (miniMap !== null) { miniMap.remove(); miniMap = null; }
  root = null;
  catId = null;
}
