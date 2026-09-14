import { dateText, esc } from '../dom.js';

/* A cat's photos, swipeable sideways.
 *
 * WHY IT EXISTS: pins bunch up. Several sightings of one cat on the same block collapse
 * into one pin, and even when they do not, two prints a few metres apart are impossible
 * to hit individually on a phone. Paging through them is the only way to see the second
 * one without fighting the map.
 *
 * ONLY THE PHOTO AREA MOVES. The name tag, the petted sticker and the date ride along in
 * each slide and are simply repeated — the first two are the CAT's and identical on every
 * frame, the date is the photo's own and is the thing that actually changes. Everything
 * below (the tags, the buttons) stays put, so the page does not appear to slide away
 * under a sideways swipe.
 *
 * Native scroll-snap rather than a JS carousel: it gets momentum, rubber-banding at the
 * ends and VoiceOver for free, and there is no gesture of ours to fight the sheet's own
 * drag-to-dismiss.
 */

function pettedSticker(petted) {
  if (petted === null || petted === undefined) return '';
  if (petted !== 'yes' && petted !== 'no') throw new Error(`unknown petted value: ${petted}`);
  const text = petted === 'yes' ? 'petted' : 'not petted';
  return `<div class="petted" data-state="${esc(petted)}">${esc(text)}</div>`;
}

/**
 * @param sightings  newest first; one slide each
 * @param opts.name  the cat's display name, repeated on every slide
 * @param opts.petted  the cat's petted state, repeated on every slide
 * @param opts.src   (sighting) => image URL; the sheet resolves pending rows locally
 */
export function filmstrip(sightings, { name, petted, src }) {
  const slides = sightings.map((s) => `
    <div class="frame">
      <figure class="print hero">
        <span class="tape" style="top:-11px;left:50%;margin-left:-44px;transform:rotate(-2deg)"></span>
        ${pettedSticker(petted)}
        <img src="${esc(src(s))}" alt="${esc(name)}" crossorigin="anonymous"
             width="${esc(String(s.photoW ?? ''))}" height="${esc(String(s.photoH ?? ''))}">
        ${s.note === null || s.note === undefined || s.note === ''
          ? '' : `<figcaption>${esc(s.note)}</figcaption>`}
      </figure>
      <div class="plate-wrap">
        <span class="tag"><span class="plate">${esc(name)}</span></span>
      </div>
      <div class="when">${esc(dateText(s.seenAt))}</div>
    </div>`).join('');

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
  let frame = 0;
  let current = startIndex;

  /* Index from the frames' REAL positions, never `scrollLeft / clientWidth`. The frames
   * are deliberately narrower than the track so the next one peeks, and there is a gap
   * between them, so a frame is not one viewport wide and that arithmetic would drift
   * further out with every slide. */
  const nearest = () => {
    let best = 0;
    let bestGap = Infinity;
    for (const [i, frame_] of [...el.children].entries()) {
      const gap = Math.abs(frame_.offsetLeft - el.scrollLeft);
      if (gap < bestGap) { bestGap = gap; best = i; }
    }
    return best;
  };

  const mark = (i) => {
    if (dots === null) return;
    for (const [n, dot] of [...dots.children].entries()) dot.classList.toggle('on', n === i);
  };

  const settle = () => {
    frame = 0;
    const i = nearest();
    if (i === current) return;
    current = i;
    mark(i);
    onChange(i);
  };
  const onScroll = () => {
    if (frame === 0) frame = requestAnimationFrame(settle);
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
    if (frame !== 0) cancelAnimationFrame(frame);
  };
}
