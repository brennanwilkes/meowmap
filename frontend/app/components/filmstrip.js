import { dateText, esc } from '../dom.js';

/* A cat's photos as a stack of polaroids, swipeable sideways.
 *
 * WHY IT EXISTS: pins bunch up. Several sightings of one cat on the same block collapse
 * into one pin, and even when they do not, two prints a few metres apart are impossible
 * to hit individually on a phone. Paging through them is the only way to see the second
 * one without fighting the map.
 *
 * ONLY THE PHOTO AREA MOVES. The name tag, the date and the petted stamp ride along in
 * each slide and are simply repeated — the name is the CAT's and identical on every
 * frame, the date is the photo's own and is the thing that actually changes. Everything
 * below (the tags, the buttons) stays put, so the page does not appear to slide away
 * under a sideways swipe.
 *
 * Native scroll-snap rather than a JS carousel: it gets momentum, rubber-banding at the
 * ends and VoiceOver for free, and there is no gesture of ours to fight the sheet's own
 * drag-to-dismiss.
 */

/* PETTED IS A STAMP IN THE WRITING AREA, not a sticker on the corner. It used to be
 * slapped over the print's top-right, overhanging it — which the filmstrip's own
 * `overflow-x` then clipped in half. Moving it into the chin removes the overflow
 * entirely rather than fighting it, and a rubber stamp on the white margin is where a
 * note like this actually goes on a photograph. */
function pettedStamp(petted, jitter) {
  if (petted === null || petted === undefined) return '';
  if (petted !== 'yes' && petted !== 'no') throw new Error(`unknown petted value: ${petted}`);
  const cls = petted === 'yes' ? 'stamp' : 'stamp pale';
  const text = petted === 'yes' ? 'petted' : 'not petted';
  return `<span class="${cls}" style="${jitter}">${text}</span>`;
}

/* A hand does not write twice in the same place, and a stamp is never pressed square.
 * The wobble is DETERMINISTIC from the sighting id rather than random: a re-render must
 * not make the whole page twitch, and the same photo should look the same every time she
 * opens it. Prime-ish moduli so the date's angle and the stamp's position do not fall
 * into step with each other down a strip. */
const WRITE_TILT = [-1.8, .9, -.6, 2.1, -1.2];
const WRITE_INDENT = [0, 7, 3, 11, 5];
const STAMP_TILT = [-8, 5, -13, 9, -4, 12];
const STAMP_RIGHT = [4, 12, 0, 18, 8, 14];
const STAMP_BOTTOM = [22, 34, 16, 28, 38, 20];

function pick(list, n) { return list[Math.abs(n) % list.length]; }

/**
 * One polaroid: the photo, the date and the petted stamp on the paper, the cat's name
 * tag hanging off the bottom edge.
 *
 * Shared with the cat page's edit mode, which shows exactly one of these.
 *
 * @param opts.name   the cat's display name
 * @param opts.petted the cat's petted state
 * @param opts.src    (sighting) => image URL; the sheet resolves pending rows locally
 * @param opts.tag    the name tag markup; defaults to a plain one
 */
export function frame(s, { name, petted, src, tag = null }) {
  /* The WINDOW takes the photo's own aspect ratio and the chin takes whatever is left,
   * which is what makes a landscape shot yield more white space instead of letterboxing.
   * A row with no stored dimensions falls back to square rather than to nothing — the
   * frame still has to have a height. */
  const ar = s.photoW > 0 && s.photoH > 0 ? `${s.photoW}/${s.photoH}` : '1';
  /* A pending row has no server id yet, so the wobble keys off seenAt instead — it only
   * has to be stable for this photo, not unique across the app. */
  const n = s.id ?? s.seenAt;
  const wrote = `transform:rotate(${pick(WRITE_TILT, n)}deg);margin-left:${pick(WRITE_INDENT, n)}px`;
  const stamped = `right:${pick(STAMP_RIGHT, n)}px;bottom:${pick(STAMP_BOTTOM, n)}px;`
    + `transform:rotate(${pick(STAMP_TILT, n)}deg)`;

  return `
    <div class="frame">
      <figure class="polaroid" style="--ar:${esc(ar)}">
        <span class="tape" style="top:-11px;left:50%;margin-left:-44px;transform:rotate(-2deg)"></span>
        <span class="window">
          <img src="${esc(src(s))}" alt="${esc(name)}" crossorigin="anonymous"
               width="${esc(String(s.photoW ?? ''))}" height="${esc(String(s.photoH ?? ''))}">
        </span>
        <figcaption class="scrawl">
          <span class="when" style="${wrote}">${esc(dateText(s.seenAt))}</span>
          ${pettedStamp(petted, stamped)}
        </figcaption>
      </figure>
      <div class="plate-wrap">
        ${tag === null ? `<span class="tag"><span class="plate">${esc(name)}</span></span>` : tag}
      </div>
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
  let frame_ = 0;
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
    frame_ = 0;
    const i = nearest();
    if (i === current) return;
    current = i;
    mark(i);
    onChange(i);
  };
  const onScroll = () => {
    if (frame_ === 0) frame_ = requestAnimationFrame(settle);
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
    if (frame_ !== 0) cancelAnimationFrame(frame_);
  };
}
