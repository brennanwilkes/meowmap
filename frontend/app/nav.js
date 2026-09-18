/* Navigation primitives, in their own module so the pages do not have to import the
 * router that imports them — an ES module cycle works here but is a trap waiting for
 * the first person who adds top-level code to main.js. */

/** Go up one level. history.back() keeps the phone's own back gesture and the in-app
 *  button meaning exactly the same thing. */
export function back(fallback = '#/map') {
  if (history.length > 1) { history.back(); return; }
  location.hash = fallback;
}

/**
 * @param opts.replace  overwrite the current history entry instead of pushing a new one.
 *
 * PULLING A SHEET DOWN SHOULD LAND ON A MAIN SCREEN, not on another sheet. Detail routes
 * all share one layer, so opening a second from inside the first looks like a replacement
 * and behaves like a stack: `back()` walks the hash history, and it found the detail she
 * had just left rather than the tab underneath — the sheet appeared to bounce back up, or
 * to need dismissing twice. Anything that swaps one detail for another passes `replace`;
 * only an entry from a TAB pushes, so there is exactly one detail entry to come back off.
 *
 * `location.replace` rather than `history.replaceState`, because only the former fires a
 * `hashchange` for a same-document fragment change — with replaceState the URL changes
 * and the router never runs.
 */
export function navigate(hash, { replace = false } = {}) {
  if (replace) { location.replace(hash); return; }
  location.hash = hash;
}
