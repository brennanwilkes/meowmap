/* Keep a Leaflet map correctly sized for as long as it is on screen.
 *
 * Leaflet measures its container ONCE, when the map is created, and never notices it
 * changing. Every mini-map in this app is created inside a detail sheet that is still
 * sliding up, inside a scroll container, above an image that has not loaded yet — so the
 * measurement it takes is routinely of a box that is the wrong size or no size at all.
 * The symptom is a map that renders blank or half-drawn, and it is intermittent, because
 * whether the layout has settled is a race.
 *
 * `requestAnimationFrame(() => map.invalidateSize())` was the previous fix and it is a
 * GUESS ABOUT TIMING: one frame is enough when the sheet is already open and not enough
 * when it is animating. A ResizeObserver is not a guess — it fires whenever the box
 * actually changes, however many times that takes and whatever caused it.
 *
 * Used by all three mini-maps (cat, sighting, capture), which is why it is a helper.
 */

export function keepSized(map, el) {
  const observer = new ResizeObserver(() => {
    // A zero box means the sheet is mid-transition or the page is hidden; invalidating
    // against it would cache another wrong size.
    if (el.clientWidth === 0 || el.clientHeight === 0) return;
    map.invalidateSize();
  });
  observer.observe(el);
  return () => observer.disconnect();
}
