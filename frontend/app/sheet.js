import { $, dateText, esc, whenText } from './dom.js';
import { photoUrl } from './api.js';
import { displayName, ringFor } from './catcolor.js';
import { navigate } from './nav.js';

/* The detail sheet. A sibling of the map div, not an L.popup — there is no L.popup or
 * L.tooltip anywhere in this codebase.
 *
 * THE SHEET IS A GLANCE, NOT AN EDITOR. It stays read-only on purpose: it is a peek at
 * a pin you tapped while panning the map, and the tags render as static stickers rather
 * than as tappable-but-dead controls. "Open" goes to `#/sighting/<id>`, which is the
 * one place editing happens — one editor, not two that must agree. */

const FILLS = ['var(--marigold)', 'var(--coral)', 'var(--jade)', 'var(--peri)'];
const ON_DARK = new Set(['var(--coral)', 'var(--peri)']);

let objectUrls = new Set();

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

function tagSticker(label, i) {
  const fill = FILLS[i % FILLS.length];
  const dark = ON_DARK.has(fill) ? ' on-dark' : '';
  const tilt = i % 2 === 0 ? '-2deg' : '1.5deg';
  return `<span class="chip${dark}" aria-pressed="true" style="--fill:${fill};--tilt:${tilt}">${esc(label)}</span>`;
}

function pettedSticker(petted) {
  if (petted === null || petted === undefined) return '';
  if (petted !== 'yes' && petted !== 'no') throw new Error(`unknown petted value: ${petted}`);
  const text = petted === 'yes' ? 'petted' : 'not petted';
  return `<div class="petted" data-state="${esc(petted)}">${esc(text)}</div>`;
}

export function openSightingSheet(sighting, cat, members = null) {
  const sheet = $('#sheet');
  const veil = $('#veil');
  releaseUrls();

  const name = cat === null || cat === undefined ? 'Not named yet' : displayName(cat);
  const ring = ringFor(sighting.catId);
  /* Coat, size and petted describe the animal, so they come off the CAT. A sighting
   * still queued for upload has no cat yet — the Worker mints one when it lands — so
   * until then it carries the tags she typed on the capture form. */
  const tagged = cat === null || cat === undefined ? sighting : cat;
  const tags = Array.isArray(tagged.coat) ? tagged.coat : [];
  const others = members === null ? [] : members.slice(1);

  const pendingNote = sighting.pending === true
    ? `<div class="map-note" style="position:static;margin-bottom:12px">
         <strong>Not uploaded yet.</strong> Keep the app open and it will sort itself out.
       </div>`
    : '';

  sheet.innerHTML = `
    <div class="grabber"></div>
    ${pendingNote}
    ${pettedSticker(tagged.petted)}
    <figure class="print">
      <span class="tape" style="top:-11px;left:50%;margin-left:-44px;transform:rotate(-2deg)"></span>
      <img src="${esc(photoFor(sighting))}" alt="${esc(name)}"
           crossorigin="anonymous" style="height:190px">
      ${sighting.note === null || sighting.note === undefined || sighting.note === ''
        ? '' : `<figcaption>${esc(sighting.note)}</figcaption>`}
    </figure>
    <div class="label">
      <h2>${esc(name)}</h2>
      <div class="when">${esc(dateText(sighting.seenAt))}</div>
      ${tags.length === 0 && (tagged.size === null || tagged.size === undefined) ? '' : `
        <hr class="rule">
        <div class="chiprow">
          ${tags.map(tagSticker).join('')}
          ${tagged.size === null || tagged.size === undefined
            ? '' : tagSticker(tagged.size, tags.length)}
        </div>`}
      ${others.length === 0 ? '' : `
        <hr class="rule">
        <div class="sub">Seen here ${others.length + 1} times</div>
        <div class="chiprow">
          ${others.map((o) => `<span class="chip" aria-pressed="false">${esc(whenText(o.seenAt))}</span>`).join('')}
        </div>`}
      ${sighting.pending === true ? '' : `
        <div class="sheet-acts">
          <button type="button" class="btn-stick" id="sheet-open">Edit</button>
        </div>`}
    </div>
    <div style="height:14px"></div>`;

  // A queued sighting has no server id yet, so there is nothing to open.
  if (sighting.pending !== true) {
    $('#sheet-open').addEventListener('click', () => {
      closeSheet();
      navigate(`#/sighting/${sighting.id}`);
    });
  }

  // --ring is read by the sheet's own sticker styling.
  sheet.style.setProperty('--ring', ring);
  veil.classList.add('open');
  sheet.classList.add('open');
}

export function closeSheet() {
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
  let dragging = false;
  let decided = false;
  let dy = 0;

  sheet.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) return;
    const onGrabber = e.target.closest('.grabber') !== null;
    if (!onGrabber && sheet.scrollTop > 0) return;
    startY = e.touches[0].clientY;
    dragging = true;
    decided = false;
    dy = 0;
    sheet.style.transition = 'none';
  }, { passive: true });

  sheet.addEventListener('touchmove', (e) => {
    if (!dragging) return;
    dy = e.touches[0].clientY - startY;
    if (!decided) {
      if (dy < 0) { dragging = false; sheet.style.transition = ''; return; }
      if (dy < 8) return;
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
