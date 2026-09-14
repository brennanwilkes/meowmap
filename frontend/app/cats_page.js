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
/** Object URLs minted for queued thumbnails; leaking these OOMs an iPhone. */
const objectUrls = new Set();

function releaseUrls() {
  for (const u of objectUrls) URL.revokeObjectURL(u);
  objectUrls.clear();
}

function catCard(cat) {
  const colour = catColour(cat.id);
  // Callers filter out empty cats, so there is always a face.
  const face = cat.sightings.reduce((a, b) => (b.seenAt > a.seenAt ? b : a));
  const n = cat.sightings.length;
  return `
    <button type="button" class="cat-card" data-cat="${cat.id}" style="--ring:${esc(colour.hex)}">
      <img class="cat-face" src="${esc(photoUrl(face.photoThumb))}" alt="" crossorigin="anonymous">
      <span class="nm">${esc(displayName(cat))}</span>
      <span class="why">${n === 1 ? 'seen once' : `seen ${n} times`} &middot; ${esc(whenText(face.seenAt))}</span>
    </button>`;
}

/* A queued sighting is shown but NOT selectable: grouping PATCHes by server id and it
 * does not have one yet. Showing it greyed with "uploading" is honest; hiding it makes
 * the app look like it lost a photo. */
function looseCard(s) {
  if (s.pending === true) {
    const url = URL.createObjectURL(new Blob([s.thumbBytes], { type: 'image/jpeg' }));
    objectUrls.add(url);
    return `
      <div class="loose-card waiting">
        <img src="${esc(url)}" alt="">
        <span class="why">${esc(s.state === 'failed' ? 'upload failed' : 'uploading…')}</span>
      </div>`;
  }
  const on = selected.has(s.id);
  return `
    <button type="button" class="loose-card${on ? ' picked' : ''}" data-loose="${s.id}"
            aria-pressed="${on ? 'true' : 'false'}">
      <img src="${esc(photoUrl(s.photoThumb))}" alt="" crossorigin="anonymous">
      <span class="why">${esc(whenText(s.seenAt))}</span>
    </button>`;
}

function render(state) {
  /* A cat with no sightings is an ARTEFACT, never a thing she made on purpose. Grouping
   * creates the cat first and then attaches sightings, so a part-way failure — or
   * unlinking the last one — leaves an empty shell that rendered as a grey placeholder
   * captioned "seen 0 times". It looks exactly like a broken photo. Hide them; the
   * `db-orphans` script is where they get cleaned up. */
  const cats = store.catsWithSightings(state).filter((c) => c.sightings.length > 0);
  const loose = store.looseSightings(state);
  // Drop selections whose sighting has gone (deleted elsewhere, or just grouped).
  releaseUrls();
  const liveIds = new Set(loose.map((s) => s.id));
  for (const id of selected) if (!liveIds.has(id)) selected.delete(id);

  root.innerHTML = `
    <div class="pad" id="cats-pad">
      <div class="pull" id="pull"><span>pull to refresh</span></div>
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
  wirePull();
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
    console.error('[cats] surfaced:', err);
    go.disabled = false;
    go.textContent = 'These are one cat';
  } finally {
    busy = false;
  }
}

/* Pull to refresh.
 *
 * Deliberately hand-rolled and deliberately local to this page: the map cannot have it
 * (a downward drag there pans), and the detail sheet's downward drag already means
 * dismiss. One gesture, one meaning, per surface.
 *
 * The listeners live on the .pad rather than the screen so they die with the innerHTML
 * that created them — except the move handler, which must be non-passive to stop iOS
 * rubber-banding the whole page while we are showing our own indicator.
 */
const PULL_TRIGGER_PX = 64;

function wirePull() {
  const pad = $('#cats-pad', root);
  const ind = $('#pull', root);
  let startY = 0;
  let pulling = false;
  let dy = 0;

  const onStart = (e) => {
    if (e.touches.length !== 1 || pad.scrollTop > 0) return;
    startY = e.touches[0].clientY;
    pulling = true;
    dy = 0;
    pad.style.transition = 'none';
  };
  const onMove = (e) => {
    if (!pulling) return;
    dy = e.touches[0].clientY - startY;
    if (dy <= 0) { pulling = false; pad.style.transform = ''; pad.style.transition = ''; return; }
    e.preventDefault();
    // Rubber-band: the pull gets heavier the further it goes, so it cannot be dragged
    // halfway down the screen.
    const eased = Math.min(96, dy ** 0.85);
    pad.style.transform = `translateY(${eased}px)`;
    ind.classList.toggle('ready', dy > PULL_TRIGGER_PX);
    ind.querySelector('span').textContent = dy > PULL_TRIGGER_PX ? 'release to refresh' : 'pull to refresh';
  };
  const onEnd = async () => {
    if (!pulling) return;
    pulling = false;
    pad.style.transition = '';
    pad.style.transform = '';
    if (dy > PULL_TRIGGER_PX) {
      ind.querySelector('span').textContent = 'refreshing…';
      await store.refresh();
    }
    ind.classList.remove('ready');
  };

  pad.addEventListener('touchstart', onStart, { passive: true });
  pad.addEventListener('touchmove', onMove, { passive: false });
  pad.addEventListener('touchend', onEnd, { passive: true });
  pad.addEventListener('touchcancel', onEnd, { passive: true });
}

export function mount(container) {
  root = container;
  selected = new Set();
  unsubscribe = store.subscribe(render);
  store.refresh();
}

export function unmount() {
  if (unsubscribe !== null) { unsubscribe(); unsubscribe = null; }
  releaseUrls();
  selected.clear();
  root = null;
}
