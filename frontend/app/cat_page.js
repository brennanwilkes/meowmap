import { DEFAULT_TILE_ID, LS, TILE_SOURCES } from '../config.js';
import { photoUrl } from './api.js';
import { catColour, displayName, inkFor } from './catcolor.js';
import { pinnedTags } from './components/chips.js';
import { filmstrip, wireFilmstrip } from './components/filmstrip.js';
import { getPref } from './device.js';
import { $, esc } from './dom.js';
import { navigate } from './nav.js';
import { turfRing, shouldDrawTurf } from './turf.js';
import { keepSized } from './minimap.js';
import * as store from './store.js';

/* One cat, AS A GLANCE AND NOTHING ELSE: every photograph of them, what they look like,
 * and where they live.
 *
 * THERE IS NO EDIT MODE HERE ANY MORE. There used to be two editors — this page for the
 * animal (name, coat, size, grouping) and `#/sighting/<id>` for the photograph (date,
 * place, note, petted) — which meant two screens to learn, two ways to reach the same
 * cat, and two layouts that had to be kept in step by hand. Tapping Edit now opens the
 * ONE editor on the photo she is looking at, where both halves live together. The rule
 * this page had always been quietly breaking is stated in CLAUDE.md: two editors that
 * must agree is a bug factory.
 *
 * What is left is the same shape as the map's bottom sheet, deliberately: a print you can
 * page sideways through, the cat's labels pinned to the page around it, and one way in.
 */

let root = null;
let catId = null;
let unsubscribe = null;
let miniMap = null;
let unsize = null;
let unstrip = null;
/* Which photo is on screen. EDIT OPENS THAT ONE, exactly as the map sheet's Edit button
 * opens the frame she swiped to. Survives a re-render; reset per mount. */
let showIndex = 0;

function render(state = store.get()) {
  if (unsize !== null) { unsize(); unsize = null; }
  if (miniMap !== null) { miniMap.remove(); miniMap = null; }

  const cat = store.catsWithSightings(state).find((c) => c.id === catId);
  if (cat === undefined) {
    root.innerHTML = '<div class="pad"><p class="empty">That cat is not here any more.</p></div>';
    return;
  }

  const colour = catColour(cat.id);
  const sightings = [...cat.sightings].sort((a, b) => b.seenAt - a.seenAt);

  if (showIndex >= sightings.length) showIndex = 0;
  const shown = sightings[showIndex];

  root.innerHTML = `
    <div class="pad" style="--ring:${esc(colour.hex)};--ring-ink:${esc(inkFor(cat.id))}">
      <div class="glance-stage">
        <button type="button" class="btn-stick sm glance-edit" id="mode">Edit</button>
        ${filmstrip(sightings, { name: displayName(cat), src: (x) => photoUrl(x.photoFull) })}
        ${pinnedTags(cat)}
      </div>

      ${sightings.length < 2 ? '' : `
        <hr class="rule">
        <h2 class="sec">Seen ${sightings.length} times</h2>
        <div class="mini-map" id="cat-map"></div>`}
    </div>`;

  if (unstrip !== null) { unstrip(); unstrip = null; }
  unstrip = wireFilmstrip($('.filmstrip', root), showIndex, (i) => { showIndex = i; });

  // The Edit button follows the swipe, so it opens the photo actually on screen.
  $('#mode', root).addEventListener('click', () => navigate(`#/sighting/${shown.id}`));

  if (sightings.length >= 2) drawTerritory(sightings, colour);
}

function drawTerritory(sightings, colour) {
  const el = $('#cat-map', root);
  if (el === null) return;

  const chosen = TILE_SOURCES.find((t) => t.id === getPref(LS.tileSource, DEFAULT_TILE_ID))
    ?? TILE_SOURCES[0];

  miniMap = L.map(el, { preferCanvas: true, attributionControl: false, zoomControl: false });
  L.tileLayer(chosen.url, {
    subdomains: chosen.subdomains ?? 'abc',
    maxZoom: chosen.maxZoom,
    maxNativeZoom: chosen.maxNativeZoom,
  }).addTo(miniMap);

  const points = sightings.map((s) => [s.lat, s.lon]);
  if (shouldDrawTurf(sightings.length)) {
    L.polygon(turfRing(points), {
      color: colour.hex, weight: 2, opacity: .85, fillColor: colour.hex, fillOpacity: .17,
      dashArray: '7 5', interactive: false,
    }).addTo(miniMap);
  } else {
    L.polyline(points, { color: colour.hex, weight: 2, dashArray: '6 6', interactive: false })
      .addTo(miniMap);
  }
  for (const s of sightings) {
    L.circleMarker([s.lat, s.lon], {
      radius: 5, color: '#2e2a24', weight: 2, fillColor: colour.hex, fillOpacity: 1,
    }).addTo(miniMap);
  }
  miniMap.fitBounds(L.latLngBounds(points).pad(0.35));
  unsize = keepSized(miniMap, el);
}

export function mount(container, arg) {
  root = container;
  catId = Number(arg);
  showIndex = 0;
  unsubscribe = store.subscribe(render);
}

export function unmount() {
  if (unstrip !== null) { unstrip(); unstrip = null; }
  if (unsubscribe !== null) { unsubscribe(); unsubscribe = null; }
  if (unsize !== null) { unsize(); unsize = null; }
  if (miniMap !== null) { miniMap.remove(); miniMap = null; }
  root = null;
  catId = null;
}
