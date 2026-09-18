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
 * A polaroid's chin is where everything true of the photograph is written, and here that
 * is SEVEN kinds of mark: the cat's name, the date, the note she wrote on it, the petted
 * stamp, one label per coat tag, the size, and the way in to edit it.
 *
 * THEY ARE ONE SYSTEM, NOT TWO. The marks were absolutely positioned from a set of
 * hand-checked arrangements while the labels and the button sat in a fixed row along the
 * bottom — which cannot distribute evenly, because neither half knows how much room the
 * other is using. The result was everything crushed against the bottom edge with a void
 * through the middle. So the chin is now a FLEX COLUMN of rows with `space-evenly`: the
 * rows spread themselves over whatever height there is, however many marks there are, and
 * the space at the top and bottom is part of the same distribution rather than left over.
 *
 * Rows, not free placement, is what makes it safe. Marks cannot overlap because they are
 * in normal flow, so a long name or eight coat tags degrade by wrapping instead of by
 * landing on top of each other — which is exactly what absolute positioning could not
 * promise once the number of marks stopped being fixed at three.
 *
 * The hand-placed feel comes from the two things that are still free: each ROW picks its
 * own horizontal alignment from a template, and each MARK gets its own small rotation.
 * Nothing lines up with anything else, which is the point.
 *
 * Everything here is DETERMINISTIC from the row's id. A re-render must not make the page
 * twitch, and a photo has to look the same every time she opens it.
 */

/* A ROW WITH TWO MARKS IN IT SPREADS; A ROW WITH ONE IS PLACED.
 *
 * Both used to come from one table of flex-start / center / flex-end, which is what made
 * the chin look uneven: `flex-start` on a row of two bunched them both against the left
 * and left the right half of the card empty. Every value here fills the width instead,
 * and all three inset the marks from the edges rather than pinning them to them. */
const ROW_SPREADS = ['space-around', 'space-evenly', 'space-between'];
/** A lone mark has nothing to spread against, so it gets placed. */
const ROW_ALIGNS = ['flex-start', 'center', 'flex-end'];
/** Walked from the photo's id so no two marks share an angle. */
const TILTS = [-2.6, 1.9, -1.4, 2.4, -3.1, 1.2, -1.8, 2.8, -2.2, 1.6];

/** At most two marks to a row: three of anything wider than a date will not fit. */
const PER_ROW = 2;

/* The name is applied to EACH PRINT SEPARATELY — written on one, stamped on the next,
 * a stuck-on label on the third — because that is what a person with a pen, a stamp and
 * a sheet of labels actually produces. Keying it to the cat instead made every frame of
 * a strip identical, which is the one thing a scrapbook never is. */
const NAME_STYLES = ['hand', 'inked', 'stuck'];

/** @param seed  the SIGHTING's id: the treatment belongs to the print, not to the cat. */
function nameStyle(seed) {
  return NAME_STYLES[Math.abs(seed ?? 0) % NAME_STYLES.length];
}

function pettedStamp(petted) {
  if (petted === null || petted === undefined) return '';
  if (petted !== 'yes' && petted !== 'no') throw new Error(`unknown petted value: ${petted}`);
  return petted === 'yes'
    ? '<span class="stamp">petted</span>'
    : '<span class="stamp pale">not petted</span>';
}

/** IDs can be 0, and a queued upload has none at all until the Worker answers. */
function canEdit(s) {
  return s.id !== null && s.id !== undefined;
}

/**
 * How many rows this print's chin needs.
 *
 * Exported shape matters: `filmstrip` takes the MAX across the strip and gives every card
 * the same answer, because the petted stamp is per-photo and one card an inch taller than
 * the one beside it reads as a layout bug rather than as a scrapbook.
 */
function rowCount(s, name, tags) {
  const marks = 1
    + (name === '' ? 0 : 1)
    + (s.note === null || s.note === undefined || s.note === '' ? 0 : 1)
    + (s.petted === null || s.petted === undefined ? 0 : 1)
    + tags.length;
  return Math.ceil(marks / PER_ROW) + (canEdit(s) ? 1 : 0);
}

/**
 * How tall the card is, from how much is written on it.
 *
 * A fixed ratio cannot work once the chin holds a variable number of marks: the .72 of
 * the real 88x107mm card starved anything past three, and a ratio deep enough for eight
 * coat tags is a bookmark rather than a photograph. The card grows by roughly one mark-row
 * at a time and is clamped at both ends, so it never stops reading as film.
 */
function cardRatio(rows) {
  return Math.min(0.80, Math.max(0.52, 0.88 - 0.055 * rows)).toFixed(3);
}

/** The marks, in rows. See the header for why this is flow and not absolute placement. */
function chin(s, name, tags) {
  const n = Math.abs(s.id ?? s.seenAt);
  /* An unnamed cat gets NO name mark, not an empty one — see displayName(). Most cats
   * live in that state, and a blank sticker or an empty rubber stamp on the white is a
   * bug with a shape, where nothing at all is just a photo she has not written on. */
  const marks = [];
  if (name !== '') marks.push(`<span class="nm ${nameStyle(n)}">${esc(name)}</span>`);
  marks.push(`<span class="when">${esc(dateText(s.seenAt))}</span>`);
  /* THE NOTE IS ALWAYS HANDWRITTEN — never stamped, never a stuck-on label, whatever
   * treatment the name happens to be wearing on this print. The other marks are facts
   * about the cat and can plausibly have been applied with a stamp or a label; a note is
   * a sentence she wrote, and there is no such thing as a rubber stamp of it. */
  if (s.note !== null && s.note !== undefined && s.note !== '') {
    marks.push(`<span class="scribble">${esc(s.note)}</span>`);
  }
  const stamp = pettedStamp(s.petted);
  if (stamp !== '') marks.push(stamp);
  for (const label of tags) marks.push(`<span class="pintag">${esc(label)}</span>`);

  const grouped = [];
  for (let i = 0; i < marks.length; i += PER_ROW) grouped.push(marks.slice(i, i + PER_ROW));
  /* The button gets a row to itself at the bottom, and is the ONE mark that is never
   * rotated: everything else here is decoration and this is a tap target. */
  if (canEdit(s)) {
    grouped.push([`<button type="button" class="btn-stick sm" data-edit="${esc(String(s.id))}">Edit</button>`]);
  }

  /* NO SPACER ROWS. Short cards used to be padded out to the strip-wide row count with
   * empty ones, which piled the slack into two or three specific gaps. The card's own
   * ratio is already computed from the strip-wide maximum, so every card is the same
   * height anyway and `space-evenly` simply opens every gap a little wider on the ones
   * with less written on them — which is the even fill this is after. */
  let m = 0;
  return grouped.map((row, r) => {
    const just = row.length > 1
      ? ROW_SPREADS[(n + r) % ROW_SPREADS.length]
      : ROW_ALIGNS[(n + r) % ROW_ALIGNS.length];
    return `
      <div class="mark-row" style="--just:${just}">
        ${row.map((html) => {
          const rot = TILTS[(n + m++) % TILTS.length];
          return `<span class="mark" style="--rot:${rot}deg">${html}</span>`;
        }).join('')}
      </div>`;
  }).join('');
}

/**
 * One polaroid.
 *
 * @param opts.name   the cat's display name
 * @param opts.src    (sighting) => image URL; the sheet resolves pending rows locally
 * @param opts.tags   the cat's coat and size labels, written on every print
 * @param opts.rows   the strip-wide row count, so every card comes out the same height.
 *                    Omitted for a lone frame, which then sizes itself.
 * @param opts.editing  BLANK FILM: nothing written on it at all. The editor has a labelled
 *                      field for every mark, and one that cannot update until Save would
 *                      sit two inches above the field contradicting it.
 */
export function frame(s, { name, src, tags = [], rows = null, editing = false }) {
  /* Square is the polaroid format, but a little off-square sneaks in more of a tall or
   * wide photo without the card stopping looking like a polaroid. Outside this band the
   * chin either swells into dead space or is squeezed down to nothing, and the window is
   * `cover` so the clamp crops rather than letterboxing. */
  const raw = s.photoW > 0 && s.photoH > 0 ? s.photoW / s.photoH : 1;
  const ar = Math.min(1.12, Math.max(0.93, raw)).toFixed(3);
  const lines = rows === null ? rowCount(s, name, tags) : rows;

  return `
    <div class="frame">
      <figure class="polaroid${editing ? ' editing' : ''}"
              style="--ar:${esc(ar)};--pr:${esc(cardRatio(lines))}">
        <span class="tape" style="top:-9px;left:50%;margin-left:-44px;transform:rotate(-2deg)"></span>
        <span class="window">
          <img src="${esc(src(s))}" alt="${esc(name === '' ? 'a cat' : name)}" crossorigin="anonymous"
               width="${esc(String(s.photoW ?? ''))}" height="${esc(String(s.photoH ?? ''))}">
        </span>
        <figcaption class="scrawl">
          ${editing ? '' : chin(s, name, tags)}
        </figcaption>
      </figure>
    </div>`;
}

/** @param sightings  newest first; one slide each */
export function filmstrip(sightings, opts) {
  /* ONE HEIGHT FOR THE WHOLE STRIP. The petted stamp is per-photo, so two prints of the
   * same cat can want a different number of rows — and a card an inch taller than the one
   * beside it reads as a layout bug rather than as a scrapbook. */
  const rows = Math.max(...sightings.map((s) => rowCount(s, opts.name, opts.tags ?? [])));
  const slides = sightings.map((s) => frame(s, { ...opts, rows })).join('');

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
 * Keep the dots in step with the strip, and report where it settles.
 *
 * `onChange` is optional — the dots are this function's own job and the only caller that
 * still wants the index is the cat page, which remembers it across a re-render. It used
 * to be how an outside Edit button found the photo on screen; the button lives on the
 * print now, so nothing has to be kept in sync. Returns a cleanup function.
 */
export function wireFilmstrip(el, startIndex, onChange = null) {
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
    if (onChange !== null) onChange(i);
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
