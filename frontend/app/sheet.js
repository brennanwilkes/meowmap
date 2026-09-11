import { $, dateText, esc, whenText } from './dom.js';
import { photoUrl } from './api.js';
import { displayName, ringFor } from './catcolor.js';

/* The detail sheet. A sibling of the map div, not an L.popup — there is no L.popup or
 * L.tooltip anywhere in this codebase.
 *
 * STATE OF PLAY: this is currently READ-ONLY. Editing (toggling chips, moving the pin,
 * renaming) needs an upload pass, and the Turnstile exchange lands with the capture
 * page. Rendering chips that look tappable but silently fail would be worse than not
 * showing the unselected ones at all, so only the chosen tags are drawn — as static
 * stickers. When editing lands, the full chip row replaces this block. */

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
  const text = petted === 'yes' ? 'petted' : petted === 'no' ? 'not petted' : 'it fled';
  return `<div class="petted" data-state="${esc(petted)}">${esc(text)}</div>`;
}

export function openSightingSheet(sighting, cat, members = null) {
  const sheet = $('#sheet');
  const veil = $('#veil');
  releaseUrls();

  const name = cat === null || cat === undefined ? 'Not named yet' : displayName(cat);
  const ring = ringFor(sighting.catId);
  const tags = Array.isArray(sighting.coat) ? sighting.coat : [];
  const others = members === null ? [] : members.slice(1);

  const pendingNote = sighting.pending === true
    ? `<div class="map-note" style="position:static;margin-bottom:12px">
         <strong>Not uploaded yet.</strong> Keep the app open and it will sort itself out.
       </div>`
    : '';

  sheet.innerHTML = `
    <div class="grabber"></div>
    ${pendingNote}
    ${pettedSticker(sighting.petted)}
    <figure class="print">
      <span class="tape" style="top:-11px;left:50%;margin-left:-44px;transform:rotate(-2deg)"></span>
      <img src="${esc(photoFor(sighting))}" alt="${esc(name)}"
           crossorigin="anonymous" style="height:190px">
      ${sighting.note === null || sighting.note === undefined || sighting.note === ''
        ? '' : `<figcaption>${esc(sighting.note)}</figcaption>`}
    </figure>
    <div class="label">
      <h2>${esc(name)}</h2>
      <div class="sub">${esc(whenText(sighting.seenAt))}</div>
      <div class="when">${esc(dateText(sighting.seenAt))}</div>
      ${tags.length === 0 && (sighting.size === null || sighting.size === undefined) ? '' : `
        <hr class="rule">
        <div class="chiprow">
          ${tags.map(tagSticker).join('')}
          ${sighting.size === null || sighting.size === undefined
            ? '' : tagSticker(sighting.size, tags.length)}
        </div>`}
      ${others.length === 0 ? '' : `
        <hr class="rule">
        <div class="sub">Seen here ${others.length + 1} times</div>
        <div class="chiprow">
          ${others.map((o) => `<span class="chip" aria-pressed="false">${esc(whenText(o.seenAt))}</span>`).join('')}
        </div>`}
    </div>
    <div style="height:14px"></div>`;

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
