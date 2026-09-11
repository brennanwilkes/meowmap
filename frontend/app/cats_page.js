import { photoUrl, createCat, patchSighting } from './api.js';
import { catColour, displayName } from './catcolor.js';
import { $, esc, whenText } from './dom.js';
import { navigate } from './nav.js';
import * as store from './store.js';
import * as turnstile from './turnstile.js';

/* The Cats tab: named and unnamed cats above, still-unidentified sightings below.
 *
 * "Not identified yet" is a FIRST-CLASS, PERMANENT state, not a to-do list. Most
 * sightings will live there and that is the design working, so the loose section is
 * never styled as a warning and is never counted down.
 *
 * The one action here is grouping: select loose sightings, say "these are one cat".
 */

let root = null;
let unsubscribe = null;
let selected = new Set();
let busy = false;

function catCard(cat) {
  const colour = catColour(cat.id);
  const face = cat.sightings.length === 0
    ? null
    : cat.sightings.reduce((a, b) => (b.seenAt > a.seenAt ? b : a));
  const n = cat.sightings.length;
  return `
    <button type="button" class="cat-card" data-cat="${cat.id}" style="--ring:${esc(colour.hex)}">
      ${face === null
        ? '<span class="cat-face empty"></span>'
        : `<img class="cat-face" src="${esc(photoUrl(face.photoThumb))}" alt="" crossorigin="anonymous">`}
      <span class="nm">${esc(displayName(cat))}</span>
      <span class="why">${n === 1 ? 'seen once' : `seen ${n} times`}${
        face === null ? '' : ` &middot; ${esc(whenText(face.seenAt))}`}</span>
    </button>`;
}

function looseCard(s) {
  const on = selected.has(s.id);
  return `
    <button type="button" class="loose-card${on ? ' picked' : ''}" data-loose="${s.id}"
            aria-pressed="${on ? 'true' : 'false'}">
      <img src="${esc(photoUrl(s.photoThumb))}" alt="" crossorigin="anonymous">
      <span class="why">${esc(whenText(s.seenAt))}</span>
    </button>`;
}

function render(state) {
  const cats = store.catsWithSightings(state);
  const loose = store.looseSightings(state);
  // Drop selections whose sighting has gone (deleted elsewhere, or just grouped).
  const liveIds = new Set(loose.map((s) => s.id));
  for (const id of selected) if (!liveIds.has(id)) selected.delete(id);

  root.innerHTML = `
    <div class="pad">
      ${cats.length === 0 && loose.length === 0 ? `
        <p class="empty">No cats yet. Tap <strong>Snap</strong> and go find one.</p>` : ''}

      ${cats.length === 0 ? '' : `
        <div class="cat-grid">${cats.map(catCard).join('')}</div>`}

      ${loose.length === 0 ? '' : `
        <hr class="rule">
        <h2 class="sec">Not identified yet</h2>
        <p class="hand">tap a few that are the same cat</p>
        <div class="loose-grid">${loose.map(looseCard).join('')}</div>`}
    </div>

    <div class="group-bar${selected.size === 0 ? ' down' : ''}" id="group-bar">
      <span>${selected.size} selected</span>
      <button type="button" class="btn-ghost" id="clear-sel">Clear</button>
      <button type="button" class="btn-stick" id="group-go">These are one cat</button>
    </div>`;

  wire();
}

function wire() {
  for (const btn of root.querySelectorAll('.cat-card')) {
    btn.addEventListener('click', () => navigate(`#/cat/${btn.dataset.cat}`));
  }
  for (const btn of root.querySelectorAll('.loose-card')) {
    btn.addEventListener('click', () => {
      const id = Number(btn.dataset.loose);
      if (selected.has(id)) selected.delete(id); else selected.add(id);
      render(store.get());
    });
  }
  $('#clear-sel', root).addEventListener('click', () => { selected.clear(); render(store.get()); });
  $('#group-go', root).addEventListener('click', group);
}

/**
 * Make one cat out of the selected sightings.
 *
 * Deliberately NOT atomic, and it cannot be: there is no bulk endpoint, so this is one
 * POST /cats followed by N PATCHes. A failure part-way leaves a real cat with some of
 * its sightings attached — which is recoverable by hand and visible on screen. The
 * alternative, rolling back by deleting the cat, risks destroying links that DID land.
 */
async function group() {
  if (selected.size === 0 || busy) return;
  busy = true;
  const bar = $('#group-bar', root);
  const go = $('#group-go', root);
  go.disabled = true;
  go.textContent = 'Grouping…';

  try {
    await turnstile.ensurePass();
    const { cat } = await createCat(null, null);
    const ids = [...selected];
    for (const id of ids) {
      // eslint-disable-next-line no-await-in-loop -- serial on purpose; see above
      await patchSighting(id, { catId: cat.id });
    }
    selected.clear();
    await store.refresh();
    navigate(`#/cat/${cat.id}`);
  } catch (err) {
    console.error('[cats] group failed:', err);
    bar.insertAdjacentHTML('beforebegin',
      `<div class="map-note" id="group-err">${esc(err.message)}</div>`);
    go.disabled = false;
    go.textContent = 'These are one cat';
  } finally {
    busy = false;
  }
}

export function mount(container) {
  root = container;
  selected = new Set();
  unsubscribe = store.subscribe(render);
}

export function unmount() {
  if (unsubscribe !== null) { unsubscribe(); unsubscribe = null; }
  selected.clear();
  root = null;
}
