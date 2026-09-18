import { $, esc } from './dom.js';
import { photoUrl } from './api.js';
import { displayName, inkFor, ringFor } from './catcolor.js';
import { navigate } from './nav.js';
import { filmstrip, wireFilmstrip } from './components/filmstrip.js';
import { pinnedTags } from './components/chips.js';

/* The detail sheet. A sibling of the map div, not an L.popup — there is no L.popup or
 * L.tooltip anywhere in this codebase.
 *
 * THE SHEET IS A GLANCE, NOT AN EDITOR. It stays read-only on purpose: it is a peek at
 * a pin you tapped while panning the map, and the tags render as static stickers rather
 * than as tappable-but-dead controls. "Open" goes to `#/sighting/<id>`, which is the
 * one place editing happens — one editor, not two that must agree. */

let objectUrls = new Set();
/** The frame currently on screen, so Edit opens what she is looking at. */
let showing = null;
let unstrip = null;

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

  const name = cat === null || cat === undefined ? 'Not named yet' : displayName(cat);
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
  showing = shots[startIndex] ?? sighting;

  sheet.innerHTML = `
    <div class="grabber"></div>
    ${pendingNote}
    <div class="glance-stage">
      ${sighting.pending === true ? '' : `
        <button type="button" class="btn-stick sm glance-edit" id="sheet-open">Edit</button>`}
      ${filmstrip(shots, { name, src: photoFor })}
      ${pinnedTags(tagged)}
    </div>`;

  if (unstrip !== null) { unstrip(); unstrip = null; }
  // The Edit button follows the swipe: it must open the photo actually on screen.
  unstrip = wireFilmstrip($('.filmstrip', sheet), startIndex, (i) => { showing = shots[i]; });

  // A queued sighting has no server id yet, so there is nothing to open.
  if (sighting.pending !== true) {
    $('#sheet-open').addEventListener('click', () => {
      closeSheet();
      navigate(`#/sighting/${showing.id}`);
    });
  }

  // --ring is read by the sheet's own sticker styling.
  sheet.style.setProperty('--ring', ring);
  // The name tag fills with --ring, so its text colour has to travel with it.
  sheet.style.setProperty('--ring-ink', inkFor(sighting.catId));
  veil.classList.add('open');
  sheet.classList.add('open');
}

export function closeSheet() {
  if (unstrip !== null) { unstrip(); unstrip = null; }
  $('#veil').classList.remove('open');
  $('#sheet').classList.remove('open');
  releaseUrls();
}

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

(() => {
  const sheet = document.getElementById('sheet');
  let startY = 0;
  let startX = 0;
  let dragging = false;
  let decided = false;
  let dy = 0;

  sheet.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) return;
    /* The filmstrip is its own scroller and owns sideways movement. Without this, paging
     * to the next photo with any downward drift dismisses the sheet instead. */
    if (e.target.closest('.filmstrip') !== null) return;
    const onGrabber = e.target.closest('.grabber') !== null;
    if (!onGrabber && sheet.scrollTop > 0) return;
    startY = e.touches[0].clientY;
    startX = e.touches[0].clientX;
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
      if (Math.abs(dx) > Math.abs(dy) || dy < 0) { dragging = false; sheet.style.transition = ''; return; }
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
