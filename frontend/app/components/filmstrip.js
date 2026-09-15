import { dateText, esc } from '../dom.js';

/* A cat's photos as a stack of polaroids, swipeable sideways.
 *
 * WHY IT EXISTS: pins bunch up. Several sightings of one cat on the same block collapse
 * into one pin, and even when they do not, two prints a few metres apart are impossible
 * to hit individually on a phone. Paging through them is the only way to see the second
 * one without fighting the map.
 *
 * ONLY THE PHOTO AREA MOVES. The whole polaroid — photo, name, date, stamp — rides in
 * each slide; everything below it stays put, so the page does not appear to slide away
 * under a sideways swipe.
 *
 * Native scroll-snap rather than a JS carousel: it gets momentum, rubber-banding at the
 * ends and VoiceOver for free, and there is no gesture of ours to fight the sheet's own
 * drag-to-dismiss.
 */

/* ── what goes on the white ────────────────────────────────────────────────
 *
 * A polaroid's caption area is written on BY HAND, at whatever angle the pen happened to
 * be, wherever there was room. Three marks live there — the cat's name, the date, and the
 * petted stamp — and the arrangement is picked per photo from a set of LAYOUTS rather
 * than jittered independently, because independent jitter reads as noise and can overlap.
 *
 * Everything here is DETERMINISTIC from the row's id. A re-render must not make the page
 * twitch, and a photo has to look the same every time she opens it.
 */
const LAYOUTS = 6;

/* The name is the CAT's, so its treatment is chosen from the CAT's id — otherwise one
 * cat's name would be handwritten on one frame and stamped on the next, which reads as a
 * bug rather than as a scrapbook. */
const NAME_STYLES = ['hand', 'inked', 'stuck'];

/** Exported so the sighting page labels a cat exactly as that cat's polaroids do. */
export function nameStyle(catId) {
  return NAME_STYLES[Math.abs(catId ?? 0) % NAME_STYLES.length];
}

function pettedStamp(petted) {
  if (petted === null || petted === undefined) return '';
  if (petted !== 'yes' && petted !== 'no') throw new Error(`unknown petted value: ${petted}`);
  return petted === 'yes'
    ? '<span class="stamp">petted</span>'
    : '<span class="stamp pale">not petted</span>';
}

/**
 * One polaroid.
 *
 * @param opts.name   the cat's display name
 * @param opts.catId  which cat, so the name treatment is stable across its photos
 * @param opts.src    (sighting) => image URL; the sheet resolves pending rows locally
 * @param opts.nameHtml  replaces the name mark entirely (the cat page's edit field)
 * @param opts.editing   lay the caption out as a form instead of as handwriting
 */
export function frame(s, { name, catId, src, nameHtml = null, editing = false }) {
  /* Square is the polaroid format, but a little off-square sneaks in more of a tall or
   * wide photo without the card stopping looking like a polaroid. Outside this band the
   * chin either swells into dead space or is squeezed down to nothing, and the window is
   * `cover` so the clamp crops rather than letterboxing. */
  const raw = s.photoW > 0 && s.photoH > 0 ? s.photoW / s.photoH : 1;
  const ar = Math.min(1.12, Math.max(0.93, raw)).toFixed(3);
  const n = Math.abs(s.id ?? s.seenAt);
  const lay = editing ? '' : ` lay-${n % LAYOUTS}`;
  const style = nameStyle(catId);

  return `
    <div class="frame">
      <figure class="polaroid${editing ? ' editing' : ''}" style="--ar:${esc(ar)}">
        <span class="tape" style="top:-9px;left:50%;margin-left:-44px;transform:rotate(-2deg)"></span>
        <span class="window">
          <img src="${esc(src(s))}" alt="${esc(name)}" crossorigin="anonymous"
               width="${esc(String(s.photoW ?? ''))}" height="${esc(String(s.photoH ?? ''))}">
        </span>
        <figcaption class="scrawl${lay}">
          ${nameHtml === null ? `<span class="nm ${style}">${esc(name)}</span>` : nameHtml}
          <span class="when">${esc(dateText(s.seenAt))}</span>
          ${pettedStamp(s.petted)}
        </figcaption>
      </figure>
    </div>`;
}

/** @param sightings  newest first; one slide each */
export function filmstrip(sightings, opts) {
  const slides = sightings.map((s) => frame(s, opts)).join('');

  /* Dots only when there is somewhere to go. Without them a single visible print gives no
   * hint that swiping does anything — the affordance has to be on screen. */
  const dots = sightings.length < 2 ? '' : `
    <div class="strip-dots" aria-hidden="true">
      ${sightings.map((_, i) => `<span${i === 0 ? ' class="on"' : ''}></span>`).join('')}
    </div>`;

  const solo = sightings.length < 2 ? ' solo' : '';
  return `<div class="filmstrip${solo}">${slides}</div>${dots}`;
}

/**
 * Track which frame is showing and report it.
 *
 * `onChange` receives the index whenever it settles, so a caller can point its Edit
 * button at the photo actually on screen. Returns a cleanup function.
 */
export function wireFilmstrip(el, startIndex, onChange) {
  const dots = el.parentNode.querySelector('.strip-dots');
  let raf = 0;
  let current = startIndex;

  /* Index from the frames' REAL positions, never `scrollLeft / clientWidth`. The frames
   * are deliberately narrower than the track so the next one peeks, and there is a gap
   * between them, so a frame is not one viewport wide and that arithmetic would drift
   * further out with every slide. */
  const nearest = () => {
    let best = 0;
    let bestGap = Infinity;
    for (const [i, node] of [...el.children].entries()) {
      const gap = Math.abs(node.offsetLeft - el.scrollLeft);
      if (gap < bestGap) { bestGap = gap; best = i; }
    }
    return best;
  };

  const mark = (i) => {
    if (dots === null) return;
    for (const [n, dot] of [...dots.children].entries()) dot.classList.toggle('on', n === i);
  };

  const settle = () => {
    raf = 0;
    const i = nearest();
    if (i === current) return;
    current = i;
    mark(i);
    onChange(i);
  };
  const onScroll = () => {
    if (raf === 0) raf = requestAnimationFrame(settle);
  };
  el.addEventListener('scroll', onScroll, { passive: true });

  /* Jump to the tapped photo without animating past the others. It needs the track to
   * have been laid out, which it has not necessarily been when this runs — the sheet may
   * still be sliding up. */
  if (startIndex > 0) {
    requestAnimationFrame(() => {
      const target = el.children[startIndex];
      if (target === undefined || el.clientWidth === 0) return;
      el.scrollLeft = target.offsetLeft;
      mark(startIndex);
    });
  }

  return () => {
    el.removeEventListener('scroll', onScroll);
    if (raf !== 0) cancelAnimationFrame(raf);
  };
}
