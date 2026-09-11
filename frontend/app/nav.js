/* Navigation primitives, in their own module so the pages do not have to import the
 * router that imports them — an ES module cycle works here but is a trap waiting for
 * the first person who adds top-level code to main.js. */

/** Go up one level. history.back() keeps the phone's own back gesture and the in-app
 *  button meaning exactly the same thing. */
export function back(fallback = '#/map') {
  if (history.length > 1) { history.back(); return; }
  location.hash = fallback;
}

export function navigate(hash) {
  location.hash = hash;
}
