import { COAT_TAGS, PETTED_VALUES, SIZE_TAGS } from '../../config.js';
import { esc } from '../dom.js';

/* The coat / size / petted chip rows, shared by the capture page and the cat editor —
 * the same three rows in the same order, so they are one implementation.
 *
 * These describe the ANIMAL, so they belong to a cat, not to a sighting (migration 003).
 * On the capture page they seed the cat the Worker mints for a new photo; on the cat page
 * they edit it.
 *
 * Unselected chips LIE FLAT on the page: dashed outline, no fill, no tilt, no shadow.
 * Selected ones are stuck on. Both states come from the same physics, which is what
 * keeps them reading as stickers rather than as badges.
 */

const PETTED_LABEL = { yes: 'petted them', no: 'did not pet them' };
const FILLS = ['var(--marigold)', 'var(--coral)', 'var(--jade)', 'var(--peri)'];
const ON_DARK = new Set(['var(--coral)', 'var(--peri)']);

function chip(label, value, selected, group, i) {
  const fill = FILLS[i % FILLS.length];
  const dark = ON_DARK.has(fill) ? ' on-dark' : '';
  const tilt = i % 2 === 0 ? '-2deg' : '1.5deg';
  return `<button type="button" class="chip${dark}" data-group="${esc(group)}"
    data-value="${esc(value)}" aria-pressed="${selected ? 'true' : 'false'}"
    style="--fill:${fill};--tilt:${tilt}">${esc(label)}</button>`;
}

/** @param draft  anything carrying {coat: string[], size, petted} — a capture draft or a cat. */
export function chipRows(draft) {
  return `
    <div class="chiprow" data-chips="coat">
      ${COAT_TAGS.map((t, i) => chip(t, t, draft.coat.includes(t), 'coat', i)).join('')}
    </div>
    <hr class="rule thin">
    <div class="chiprow" data-chips="size">
      ${SIZE_TAGS.map((t, i) => chip(t, t, draft.size === t, 'size', i + 1)).join('')}
    </div>
    <hr class="rule thin">
    <div class="chiprow" data-chips="petted">
      ${PETTED_VALUES.map((v, i) => chip(PETTED_LABEL[v], v, draft.petted === v, 'petted', i + 2)).join('')}
    </div>`;
}

/**
 * Mutates `draft` in place and calls `onChange` after each tap. One delegated listener
 * per row rather than one per chip — there are thirteen of them.
 */
export function wireChips(root, draft, onChange) {
  for (const row of root.querySelectorAll('[data-chips]')) {
    row.addEventListener('click', (e) => {
      const btn = e.target.closest('.chip');
      if (btn === null) return;
      const { group, value } = btn.dataset;
      const on = btn.getAttribute('aria-pressed') === 'true';

      if (group === 'coat') {
        // Sorted, because the server stores coat as a sorted comma-joined string and an
        // unsorted client list would make two identical sightings compare unequal.
        draft.coat = on ? draft.coat.filter((t) => t !== value) : [...draft.coat, value].sort();
        btn.setAttribute('aria-pressed', on ? 'false' : 'true');
      } else {
        // size and petted are single-select, and tapping the chosen one clears it —
        // every tag here is optional and must be un-sayable as well as sayable.
        draft[group] = on ? null : value;
        for (const sib of row.querySelectorAll('.chip')) {
          sib.setAttribute('aria-pressed', String(!on && sib.dataset.value === value));
        }
      }
      onChange();
    });
  }
}

/**
 * The same tags, as STATIC stickers rather than controls.
 *
 * For the places that only report what a cat is — the map sheet and the cat page before
 * you tap Edit. Rendering the interactive row there would give tappable-looking chips
 * that do nothing, which is worse than plain text.
 */
export function staticChips(tagged) {
  const coat = Array.isArray(tagged.coat) ? tagged.coat : [];
  const all = tagged.size === null || tagged.size === undefined ? coat : [...coat, tagged.size];
  if (all.length === 0) return '';
  return `<div class="chiprow">${all.map((label, i) => {
    const fill = FILLS[i % FILLS.length];
    const dark = ON_DARK.has(fill) ? ' on-dark' : '';
    const tilt = i % 2 === 0 ? '-2deg' : '1.5deg';
    return `<span class="chip${dark}" aria-pressed="true" style="--fill:${fill};--tilt:${tilt}">${esc(label)}</span>`;
  }).join('')}</div>`;
}
