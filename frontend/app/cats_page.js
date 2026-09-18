import { photoUrl } from './api.js';
import { catColour, displayName } from './catcolor.js';
import { $, esc, whenText } from './dom.js';
import { navigate } from './nav.js';
import * as store from './store.js';

/* The Cats tab.
 *
 * Every sighting arrives already belonging to a cat of its own (the Worker mints one on
 * upload), so this is simply a list of cats and tapping one opens it.
 *
 * THERE IS NO SELECTION MODE HERE, deliberately. A multi-select merge was built and cut:
 * it meant one tap opened a cat and the next tap selected it, which is a mode you can be
 * in without realising, and a thing you can get wrong. Every join or split is now a
 * single tap on a face, phrased as a question, on the cat's own page — so there is no
 * sequence to learn and nothing to mess up.
 *
 * The loose section remains for any sighting with no cat. Nothing creates those any
 * more, but a row from before the change would otherwise become invisible.
 */

let root = null;
let unsubscribe = null;
/** Object URLs minted for queued thumbnails; leaking these OOMs an iPhone. */
const objectUrls = new Set();

function releaseUrls() {
  for (const u of objectUrls) URL.revokeObjectURL(u);
  objectUrls.clear();
}

/* The last time she saw them, short enough for a 104px card. The year only appears when
 * it is not this one, which is the only time it tells her anything. */
function lastSeen(ms) {
  const now = new Date();
  const then = new Date(ms);
  return new Intl.DateTimeFormat('en-CA', {
    month: 'short',
    day: 'numeric',
    year: then.getFullYear() === now.getFullYear() ? undefined : 'numeric',
  }).format(then);
}

function catCard(cat) {
  const colour = catColour(cat.id);
  // Callers filter out empty cats, so there is always a face.
  const face = cat.sightings.reduce((a, b) => (b.seenAt > a.seenAt ? b : a));
  /* A stamped count and a date, not a sentence: see .cat-card .caption. The count has no
   * unit because the stamp is on a photograph of the cat — there is nothing else it
   * could be counting. */
  return `
    <button type="button" class="cat-card" data-cat="${cat.id}" style="--ring:${esc(colour.hex)}">
      <img class="cat-face" src="${esc(photoUrl(face.photoThumb))}" alt="" crossorigin="anonymous">
      ${displayName(cat) === '' ? '' : `<span class="nm">${esc(displayName(cat))}</span>`}
      <span class="caption">
        <span class="stamp round" aria-label="seen ${cat.sightings.length} times">${cat.sightings.length}</span>
        <span class="seen">${esc(lastSeen(face.seenAt))}</span>
      </span>
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
  return `
    <button type="button" class="loose-card" data-loose="${s.id}">
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

  root.innerHTML = `
    <div class="pad" id="cats-pad">
      <div class="pull" id="pull"><span>pull to refresh</span></div>
      ${cats.length !== 0 || loose.length !== 0 ? '' : (state.error === null
        ? `<p class="empty">No cats yet. Tap the camera below and go find one.</p>`
        /* NOT "no cats yet" when the load failed — that is a lie, and the lie she would
         * read is that her cats are gone. Say what happened and offer the retry. */
        : `<p class="empty">Couldn’t load your cats.</p>
           <p class="hand" style="text-align:center">${esc(state.error)}</p>
           <button type="button" class="btn-stick wide" id="retry">Try again</button>`)}

      ${cats.length === 0 ? '' : `
        <div class="cat-grid">${cats.map(catCard).join('')}</div>`}

      ${loose.length === 0 ? '' : `
        <hr class="rule">
        <h2 class="sec">No cat yet</h2>
        <div class="loose-grid">${loose.map(looseCard).join('')}</div>`}
    </div>
`;

  wire();
}

function wire() {
  const retry = $('#retry', root);
  if (retry !== null) retry.addEventListener('click', () => store.refresh());

  for (const btn of root.querySelectorAll('.cat-card')) {
    btn.addEventListener('click', () => navigate(`#/cat/${btn.dataset.cat}`));
  }
  for (const btn of root.querySelectorAll('.loose-card[data-loose]')) {
    btn.addEventListener('click', () => navigate(`#/sighting/${btn.dataset.loose}`));
  }
  wirePull();
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
  unsubscribe = store.subscribe(render);
  store.refresh();
}

export function unmount() {
  if (unsubscribe !== null) { unsubscribe(); unsubscribe = null; }
  releaseUrls();
  root = null;
}
