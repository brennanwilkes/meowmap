import { $, esc } from './dom.js';
import { photoUrl } from './api.js';
import { displayName, inkFor, ringFor } from './catcolor.js';
import { navigate } from './nav.js';
import { filmstrip, wireFilmstrip } from './components/filmstrip.js';
import { tagLabels } from './components/chips.js';

/* The detail sheet. A sibling of the map div, not an L.popup — there is no L.popup or
 * L.tooltip anywhere in this codebase.
 *
 * THE SHEET IS A GLANCE, NOT AN EDITOR. It stays read-only on purpose: it is a peek at
 * a pin you tapped while panning the map, and the tags render as static stickers rather
 * than as tappable-but-dead controls. "Open" goes to `#/sighting/<id>`, which is the
 * one place editing happens — one editor, not two that must agree. */

let objectUrls = new Set();
let unstrip = null;
/** Pending `.up` removal, so a reopen mid-slide cancels the teardown. */
let hideTimer = null;
/* --turn is 280ms; this is that plus a frame. It has to outlast the slide-down, because
 * the sheet still has to be on screen while it plays. A CSS token cannot be read
 * reliably before first paint, so this is the one place the number is duplicated. */
const SHEET_HIDE_MS = 320;

function releaseUrls() {
  for (const u of objectUrls) URL.revokeObjectURL(u);
  objectUrls = new Set();
}

function photoFor(s) {
  if (s.pending === true) {
    const url = URL.createObjectURL(new Blob([s.fullBytes ?? s.thumbBytes], { type: 'image/jpeg' }));
    objectUrls.add(url);
    return url;
  }
  return photoUrl(s.photoFull);
}

export function openSightingSheet(sighting, cat) {
  const sheet = $('#sheet');
  const veil = $('#veil');
  releaseUrls();

  const name = displayName(cat);
  const ring = ringFor(sighting.catId);
  /* Coat and size describe the animal, so they come off the CAT; petted is the
   * SIGHTING's and rides on the polaroid itself. A sighting still queued for upload has
   * no cat yet — the Worker mints one when it lands — so until then it carries the coat
   * and size she typed on the capture form. */
  const tagged = cat === null || cat === undefined ? sighting : cat;

  const pendingNote = sighting.pending === true
    ? `<div class="map-note" style="position:static;margin-bottom:12px">
         <strong>Not uploaded yet.</strong> Keep the app open and it will sort itself out.
       </div>`
    : '';

  /* EVERY photo of this cat, newest first, opened at the one she tapped. Not just the
   * co-located cluster: pins bunch up, and "the other photos of this cat" is the question
   * being asked when she taps a pile of them. A pending row has no cat yet, so it is its
   * own single frame. */
  const shots = cat === null || cat === undefined
    ? [sighting]
    : [...cat.sightings].sort((a, b) => b.seenAt - a.seenAt);
  const startIndex = Math.max(0, shots.findIndex((x) => x.clientId === sighting.clientId));

  sheet.innerHTML = `
    <div class="grabber"></div>
    ${pendingNote}
    ${filmstrip(shots, { name, src: photoFor, tags: tagLabels(tagged) })}`;

  /* `.up` BEFORE the strip is wired. A closed sheet is display:none (see sheet.css), and
   * wireFilmstrip has to measure the track to jump to the photo she tapped — it bails on
   * a zero-width element, which is exactly what it would be measuring otherwise. The
   * forced reflow commits the off-screen position so the browser has something to
   * transition FROM; without it the display change and the transform land in one style
   * pass and the sheet appears instantly instead of sliding. */
  if (hideTimer !== null) { clearTimeout(hideTimer); hideTimer = null; }
  sheet.classList.add('up');
  void sheet.offsetHeight;

  if (unstrip !== null) { unstrip(); unstrip = null; }
  unstrip = wireFilmstrip($('.filmstrip', sheet), startIndex);

  // --ring is read by the sheet's own sticker styling.
  sheet.style.setProperty('--ring', ring);
  // The name tag fills with --ring, so its text colour has to travel with it.
  sheet.style.setProperty('--ring-ink', inkFor(sighting.catId));
  veil.classList.add('open');
  sheet.classList.add('open');
  /* THE MAP UNDERNEATH GOES INERT. The veil already covers it and should be enough, but
   * "enough" here depends on the map's panes staying inside the screen's stacking context
   * and on the veil's containing block being what it looks like — two things that are
   * true today and are one CSS change away from not being, and the failure mode is a pin
   * answering a tap meant for the sheet on top of it. A class on <body> does not depend
   * on either. It also compacts the nav, which a sheet should. */
  document.body.classList.add('sheet-up');
}

export function closeSheet() {
  const sheet = $('#sheet');
  if (!sheet.classList.contains('up')) return;   // already closed; nothing to tear down
  if (unstrip !== null) { unstrip(); unstrip = null; }
  $('#veil').classList.remove('open');
  sheet.classList.remove('open');
  /* Safe to clear unconditionally: this sheet and the detail layer are never up together
   * — opening a detail from here calls closeSheet() first, and this one only opens from
   * the map with nothing over it. */
  document.body.classList.remove('sheet-up');

  /* THE CONTENT GOES TOO, once the slide-down has played. Leaving it meant the shell
   * permanently held the last cat she tapped — which is what actually showed up under
   * the sighting editor — and it kept a filmstrip of images alive for a sheet nobody
   * could see. Revoking the object URLs waits for the same moment, or a pending photo
   * goes blank halfway down. Guarded on `.open` so reopening mid-slide cancels it. */
  if (hideTimer !== null) clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    hideTimer = null;
    if (sheet.classList.contains('open')) return;
    sheet.classList.remove('up');
    sheet.innerHTML = '';
    releaseUrls();
  }, SHEET_HIDE_MS);
}

/* Every print carries its own Edit button, so there is nothing to keep in step with the
 * swipe — the button she can see is the one on the photo she can see. A queued upload
 * has no server id yet and renders none.
 *
 * DELEGATED ONCE AT MODULE LOAD. This used to be added inside openSightingSheet, so the
 * shell accumulated one more copy of it per pin she tapped — and every copy fired. */
document.getElementById('sheet').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-edit]');
  if (btn === null) return;
  closeSheet();
  navigate(`#/sighting/${btn.dataset.edit}`);
});

// Wired once at module load; the veil and sheet are permanent shell elements, so this
// never needs tearing down with a page.
document.addEventListener('click', (e) => {
  if (e.target.id === 'veil') closeSheet();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeSheet();
});

/* Swipe the sheet back down.
 *
 * Same rule as the detail layer: a drag only starts on the grabber or with the sheet
 * scrolled to the top, and an upward or sideways drag is handed back to the content.
 * The sheet scrolls internally, so without the scrollTop check a downward flick halfway
 * through a long sighting would dismiss it instead of scrolling. */
const SHEET_DISMISS_PX = 70;
/** See main.js: how much a downward drag must out-measure a sideways one on the strip. */
const STRIP_BIAS = 1.6;

(() => {
  const sheet = document.getElementById('sheet');
  let startY = 0;
  let startX = 0;
  let dragging = false;
  let decided = false;
  let biased = false;
  let dy = 0;

  sheet.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) return;
    /* THE FILMSTRIP IS SHARED, NOT EXCLUDED — see the long note in main.js. The photo is
     * most of what is on this sheet, so excluding it left the grabber as the only surface
     * that answered a downward swipe. A touch starting there just has to clear a higher
     * bar to count as vertical. */
    const strict = e.target.closest('.filmstrip') !== null;
    const onGrabber = e.target.closest('.grabber') !== null;
    if (!onGrabber && sheet.scrollTop > 0) return;
    startY = e.touches[0].clientY;
    startX = e.touches[0].clientX;
    biased = strict;
    dragging = true;
    decided = false;
    dy = 0;
    sheet.style.transition = 'none';
  }, { passive: true });

  sheet.addEventListener('touchmove', (e) => {
    if (!dragging) return;
    dy = e.touches[0].clientY - startY;
    const dx = e.touches[0].clientX - startX;
    if (!decided) {
      /* Wait for real movement before judging direction — the first millimetre is noise,
       * and deciding from it abandons a genuine drag that started with a little wobble.
       * Same rule as the detail layer in main.js. */
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
      const needed = biased ? Math.abs(dx) * STRIP_BIAS : Math.abs(dx);
      if (dy < 0 || Math.abs(dy) <= needed) {
        dragging = false; sheet.style.transition = ''; return;
      }
      decided = true;
    }
    e.preventDefault();
    sheet.style.transform = `translateY(${dy * 0.9}px)`;
  }, { passive: false });

  const end = () => {
    if (!dragging) return;
    dragging = false;
    sheet.style.transition = '';
    sheet.style.transform = '';
    if (decided && dy > SHEET_DISMISS_PX) closeSheet();
  };
  sheet.addEventListener('touchend', end, { passive: true });
  sheet.addEventListener('touchcancel', end, { passive: true });

  // The grabber is a tap target too: a gesture with no fallback strands anyone who does
  // not discover it.
  sheet.addEventListener('click', (e) => {
    if (e.target.closest('.grabber') !== null) closeSheet();
  });
})();
