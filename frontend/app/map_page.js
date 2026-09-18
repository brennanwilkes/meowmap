import {
  COAT_TAGS, DEFAULT_BOUNDS, DEFAULT_TILE_ID, LS, PETTED_VALUES, SIZE_TAGS,
  TILE_CHANGED, TILE_SOURCES,
} from '../config.js';
import { esc } from './dom.js';
import { getJsonPref, getPref, setJsonPref } from './device.js';
import { photoUrl } from './api.js';
import * as pwa from './pwa.js';
import * as store from './store.js';
import { ringFor } from './catcolor.js';
import { TURF_MIN_ZOOM, shouldDrawTurf, turfRing } from './turf.js';
import { displayName } from './catcolor.js';
import { openSightingSheet } from './sheet.js';
import { emptyFilter, filterCats, filterSightings, isActive, toggle } from './filter.js';
import { startLocating } from './geolocate.js';

/* The map.
 *
 * Leaflet is a global from a classic <script>; never import it as a module.
 *
 * Render load is bounded by LAYER COUNT, not point count — that is the lesson from
 * vessel-tracker, where one long trail emitted ~750 polylines. Here every cat costs at
 * most one polygon plus one label plus its pins, so the budget is comfortable, but
 * markers are still diffed by key rather than cleared and rebuilt. */

let map = null;
let unsubscribe = null;
let tileLayer = null;
/** Marker/layer registries, keyed so a refresh reuses rather than recreates. */
const markers = new Map();
let turfLayers = [];
/** Every object URL we mint, revoked on unmount. Leaking these OOMs an iPhone. */
const objectUrls = new Set();
/* The coat filter. Module state rather than a pref ON PURPOSE — see filter.js: a
 * filter that survives a relaunch means opening the app tomorrow to a map missing most
 * of her cats, with nothing on screen explaining why. */
const active = emptyFilter();
/** True until the map has been built once in this page load; see mount(). */
let firstMount = true;
let mapSizer = null;
/* Double-tap detection: the second tap has to be soon enough and close enough to be the
 * same gesture rather than two deliberate taps in a row. */
const DOUBLE_TAP_MS = 320;
const DOUBLE_TAP_PX = 34;
let lastTap = null;
/** The "you are here" dot and its accuracy ring. */
let meMarker = null;
let meCircle = null;
let locating = null;

/* One scrollable strip holding every tag group, separated by a hairline so "orange |
 * chonk" reads as two decisions rather than one long list. Each group keeps its own fill
 * colour, which is what makes the AND-across-groups rule legible without a legend. */
const FILTER_ROWS = [
  { group: 'coat', values: COAT_TAGS, fill: 'var(--marigold)' },
  { group: 'size', values: SIZE_TAGS, fill: 'var(--jade)' },
  { group: 'petted', values: PETTED_VALUES, fill: 'var(--peri)', labels: { yes: 'petted', no: 'not petted' } },
];

function filterChips() {
  return FILTER_ROWS.map((row, r) => {
    const chips = row.values.map((v, i) => {
      const label = row.labels === undefined ? v : (row.labels[v] ?? v);
      return `<button type="button" class="chip" data-group="${esc(row.group)}"
        data-value="${esc(v)}" aria-pressed="false"
        style="--fill:${row.fill};--tilt:${i % 2 === 0 ? '-2deg' : '1.5deg'}">${esc(label)}</button>`;
    }).join('');
    return (r === 0 ? '' : '<span class="fdiv" aria-hidden="true"></span>') + chips;
  }).join('');
}

function tileSource() {
  const id = getPref(LS.tileSource, DEFAULT_TILE_ID);
  return TILE_SOURCES.find((t) => t.id === id) ?? TILE_SOURCES[0];
}

/** Build (or rebuild) the basemap layer from the current preference. */
function applyTileSource() {
  if (map === null) return;
  const src = tileSource();
  if (tileLayer !== null) map.removeLayer(tileLayer);
  tileLayer = L.tileLayer(src.url, {
    attribution: src.attribution,
    maxZoom: src.maxZoom,
    maxNativeZoom: src.maxNativeZoom,
    subdomains: src.subdomains ?? 'abc',
  }).addTo(map);
}

function thumbSrc(s) {
  if (s.pending === true) {
    // A queued sighting renders from its local bytes so it appears on the map the
    // instant it is taken, long before it uploads.
    const url = URL.createObjectURL(new Blob([s.thumbBytes], { type: 'image/jpeg' }));
    objectUrls.add(url);
    return url;
  }
  return photoUrl(s.photoThumb);
}

function pinIcon(s, ring, count) {
  const cls = ['pin'];
  if (s.pending === true) cls.push('pending');
  else if (s.catId === null || s.catId === undefined) cls.push('loose');
  if (s.id % 2 === 1) cls.push('alt');

  if (count > 1) cls.push('stack');

  /* A stack of prints, not one print wearing a number: the count is the stamp on top and
   * <s> is the corner of the print underneath showing past it. Several photos collapsed
   * into one pin should LOOK like several photos before the number is read. */
  const under = count > 1 ? '<s></s>' : '';
  const badge = count > 1
    ? `<b class="stamp round">&times;${count}</b>`
    : (s.pending === true ? '<b class="stamp round">!</b>' : '');
  return L.divIcon({
    className: cls.join(' '),
    // The photo is its own element inside the print, so the mount and the chin below it
    // stay paper rather than being covered by the image.
    html: `${under}<i style="--ring:${esc(ring)}"><u style="background-image:url(${esc(thumbSrc(s))})"></u></i>${badge}`,
    iconSize: [52, 60],
    iconAnchor: [26, 69],
  });
}

/**
 * Collapse sightings of the SAME cat within ~40 m into one pin with a count.
 *
 * Deliberately not generic marker clustering: a cat photographed on the same fence
 * eight times should be one pin, but two different cats on one doorstep must stay two
 * pins. Clustering by screen proximity gets that backwards, and it would need a plugin.
 *
 * 40 m, not the 15 m it started at. A pin is 52 px wide and at zoom 17 a metre is about
 * a pixel, so two prints 15-30 m apart overlap on screen while still counting as two
 * pins — she could see there were two and could not tap either of them. The radius has
 * to exceed the pin's own footprint, not merely "the same fence".
 */
function collapse(sightings) {
  const groups = [];
  const MERGE_DEG = 40 / 111_320;   // ~40 m
  for (const s of sightings) {
    const key = s.catId === null || s.catId === undefined ? `loose:${s.id ?? s.clientId}` : `cat:${s.catId}`;
    const hit = groups.find((g) =>
      g.key === key &&
      Math.abs(g.lat - s.lat) < MERGE_DEG &&
      Math.abs(g.lon - s.lon) < MERGE_DEG);
    if (hit === undefined) groups.push({ key, lat: s.lat, lon: s.lon, members: [s] });
    else hit.members.push(s);
  }
  return groups;
}

function clearTurf() {
  for (const l of turfLayers) map.removeLayer(l);
  turfLayers = [];
}

function drawTurf(state) {
  clearTurf();
  // Filtered here as well as in drawPins: a turf blob computed from points that are not
  // drawn is a shaded zone with nothing inside it.
  for (const cat of filterCats(store.catsWithSightings(state), active)) {
    const pts = cat.sightings.map((s) => [s.lat, s.lon]);
    const ring = ringFor(cat.id);

    // A lone sighting is just a pin; from the second onwards it earns a territory.
    if (!shouldDrawTurf(pts.length)) continue;

    const { ring: poly, centre } = turfRing(pts);
    turfLayers.push(L.polygon(poly, {
      color: ring, weight: 2.5, dashArray: '7 7', opacity: .9,
      fillColor: ring, fillOpacity: 0.17, interactive: false, smoothFactor: 1,
    }).addTo(map));

    turfLayers.push(
      L.marker(centre, {
        // Its own pane, because both labels and pins are markers and markerPane sorts
        // by LATITUDE — a zIndexOffset fight would work by accident and break the
        // moment a pin drifted north of the label.
        pane: 'turf',
        keyboard: false,
        icon: L.divIcon({
          className: 'turf-label',
          html: `<span>${esc(displayName(cat))}&rsquo;s turf</span>`,
          iconSize: [140, 22], iconAnchor: [70, 11],
        }),
      }).addTo(map).on('click', () => openSightingSheet(cat.sightings[0], cat)),
    );
  }
  updateTurfLabels();
}

/** Zoomed out the blob is small and the label just collides with its neighbours. */
function updateTurfLabels() {
  if (map === null) return;
  const show = map.getZoom() >= TURF_MIN_ZOOM;
  for (const el of document.querySelectorAll('.turf-label')) {
    el.style.display = show ? '' : 'none';
  }
}

/* WITH its sightings attached: the sheet pages through every photo of the cat, not just
 * the ones collapsed into this pin. Bunched pins are exactly the case where "show me the
 * others" matters, and the others are usually NOT at the same spot. */
function catFor(s, state) {
  if (s.catId === null || s.catId === undefined) return null;
  return store.catsWithSightings(state).find((c) => c.id === s.catId) ?? null;
}

function drawPins(state) {
  const catsById = new Map(state.cats.map((c) => [c.id, c]));
  const groups = collapse(filterSightings(store.renderableSightings(state), catsById, active));
  const seen = new Set();

  for (const g of groups) {
    const head = g.members[0];
    const key = `${g.key}@${g.lat.toFixed(5)},${g.lon.toFixed(5)}`;
    seen.add(key);

    // A queued upload keeps the amber treatment; everything else gets its cat's colour,
    // or its own id's colour while it is still unidentified.
    const ring = head.pending === true
      ? 'var(--marigold)'
      : ringFor(head.catId, head.id ?? null);
    const icon = pinIcon(head, ring, g.members.length);

    const existing = markers.get(key);
    if (existing !== undefined) {
      existing.setLatLng([g.lat, g.lon]);
      existing.setIcon(icon);
      existing.off('click');
      existing.on('click', () => openSightingSheet(head, catFor(head, state)));
      continue;
    }
    const m = L.marker([g.lat, g.lon], { icon })
      .addTo(map)
      .on('click', () => openSightingSheet(head, catFor(head, state)));
    markers.set(key, m);
  }

  for (const [key, m] of markers) {
    if (!seen.has(key)) { map.removeLayer(m); markers.delete(key); }
  }
}

/* Two things can want this strip, and the outbox outranks a fetch failure: a photo that
 * has not uploaded is HER data at risk, while stale pins are an inconvenience that fixes
 * itself. Never both at once — a second banner would cover the map it is apologising
 * about. */
function renderBanner(state) {
  const el = document.getElementById('outboxBanner');
  if (el === null) return;
  const n = state.pending.length;

  if (n > 0) {
    el.style.display = '';
    el.classList.remove('offline');
    el.textContent = n === 1
      ? '1 photo still to upload — keep the app open'
      : `${n} photos still to upload — keep the app open`;
    return;
  }

  /* A FAILED REFRESH IS ONLY WORTH SAYING WHEN SOMETHING IS SHOWING. With pins on screen
   * this explains why a cat she just added is missing; with nothing on screen the page
   * itself says so (see emptyState), and a banner over a blank map is just noise. */
  if (state.error !== null && state.loaded) {
    el.style.display = '';
    el.classList.add('offline');
    el.textContent = `Showing what was here last time — ${state.error}`;
    return;
  }
  el.style.display = 'none';
}

/* Nothing on the map, and it matters WHY. "No cats yet" is an invitation; the same words
 * over a failed load are a lie that makes her think she lost her cats. */
function renderEmpty(state) {
  const el = document.getElementById('map-empty');
  if (el === null) return;
  const nothing = state.sightings.length === 0 && state.pending.length === 0;
  if (!nothing) { el.style.display = 'none'; return; }
  el.style.display = '';
  el.innerHTML = state.error === null
    ? `<p class="empty">No cats yet.<br>Tap the camera below and go find one.</p>`
    : `<p class="empty">Couldn’t load your cats.</p>
       <p class="hand">${esc(state.error)}</p>
       <button type="button" class="btn-stick" id="retry">Try again</button>`;
  const retry = document.getElementById('retry');
  if (retry !== null) retry.addEventListener('click', () => store.refresh());
}

export function mount(el) {
  el.innerHTML = `
    <div id="map"></div>
    <div class="coat-filter" id="coatFilter">${filterChips()}</div>
    <div class="outbox-banner" id="outboxBanner" style="display:none"></div>
    <div class="map-empty" id="map-empty" style="display:none"></div>
    <div id="install-slot"></div>`;

  /* EVERY FRESH PAGE LOAD OPENS ON VICTORIA, whatever was saved and wherever the cats
   * are. The saved view only survives switching tabs within one session, which is the
   * case it was actually for — coming back to the map mid-task and finding it moved is
   * the annoying version. Opening the app tomorrow somewhere else because of where she
   * happened to pan yesterday is the more annoying one.
   *
   * The module is evaluated once per page load, so this flag IS "fresh load". */
  const view = firstMount ? null : getJsonPref(LS.lastView, null);
  firstMount = false;

  /* No attribution control at all, and no credits button — Brennan's call for a private
   * two-person app after the (i) button was tried and judged clutter. Noted rather than
   * silently done: OSM's ODbL does ask for credit, so this is a deliberate decision and
   * not an oversight. If Meowmap is ever made public, the credits go back. */
  map = L.map('map', {
    zoomControl: false,
    attributionControl: false,
    preferCanvas: true,
    /* Handled below instead. Leaflet's own double-click zoom rides on the container's
     * `dblclick`, which iOS does not reliably deliver inside an element that has claimed
     * touch-action — so on the phone, double-tapping the map did nothing at all. */
    doubleClickZoom: false,
  });

  // Frame the walkable core of Victoria, James Bay to Mount Tolmie. Fitting bounds rather
  // than a fixed zoom means the same area is framed on a phone and on a laptop, instead
  // of being right on whichever screen it was tuned against.
  const frameDefault = () => map.fitBounds([
    [DEFAULT_BOUNDS.sw.lat, DEFAULT_BOUNDS.sw.lon],
    [DEFAULT_BOUNDS.ne.lat, DEFAULT_BOUNDS.ne.lon],
  ]);
  if (view === null) frameDefault();
  else map.setView([view.lat, view.lon], view.zoom);

  map.createPane('turf');
  map.getPane('turf').style.zIndex = '650';

  applyTileSource();
  window.addEventListener(TILE_CHANGED, applyTileSource);

  /* THE CONTAINER HAS NOT LAID OUT YET, and a single rAF is a guess about when it will.
   *
   * fitBounds computes a zoom for the viewport Leaflet last measured. Measured against a
   * box that is still zero-height, that zoom is wildly wrong — which is the "sometimes
   * the map opens zoomed right out" bug, and it is intermittent precisely because
   * whether the layout has settled is a race. invalidateSize alone does not fix it: it
   * corrects the SIZE and leaves the wrong zoom in place.
   *
   * So re-frame once, the first time the box is real. Later resizes (rotation, the
   * keyboard) still get invalidateSize but must NOT re-frame — by then she has panned
   * somewhere and yanking the map back would be its own bug. */
  let needsFraming = view === null;
  const mapEl = document.getElementById('map');
  mapSizer = new ResizeObserver(() => {
    // A zero box means the screen is mid-transition; measuring against it would cache
    // another wrong size, which is the thing this observer exists to stop.
    if (mapEl.clientWidth === 0 || mapEl.clientHeight === 0) return;
    map.invalidateSize();
    if (needsFraming) { needsFraming = false; frameDefault(); }
  });
  mapSizer.observe(mapEl);

  /* Double-tap to zoom, by hand. Two taps close together in time and place, which is what
   * the gesture actually is — rather than trusting a synthesised dblclick that iOS does
   * not send here. `setZoomAround` keeps the tapped point under the finger, so it zooms
   * into what she pointed at instead of into the middle of the screen. */
  map.on('click', (e) => {
    const now = e.originalEvent.timeStamp;
    const p = e.containerPoint;
    if (lastTap !== null
        && now - lastTap.t < DOUBLE_TAP_MS
        && p.distanceTo(lastTap.p) < DOUBLE_TAP_PX) {
      lastTap = null;
      map.setZoomAround(e.latlng, map.getZoom() + 1);
      return;
    }
    lastTap = { t: now, p };
  });

  map.on('zoomend', updateTurfLabels);
  map.on('moveend', () => {
    const c = map.getCenter();
    setJsonPref(LS.lastView, { lat: c.lat, lon: c.lng, zoom: map.getZoom() });
  });

  // Drop the dot on open without moving the view: she is usually looking at a place she
  // chose, and yanking the map to her position would undo that. There is no recentre
  // button any more, so this is the only caller.
  locateMe();

  /* The install hint lived on the Snap page, which no longer exists. It has to live
   * SOMEWHERE: installing is what makes storage.persist() likely to be granted, and an
   * evicted outbox loses the only copy of a photo taken with the in-app camera. */
  pwa.maybeOfferInstall(document.getElementById('install-slot'));

  document.getElementById('coatFilter').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-group]');
    if (btn === null) return;
    const { group, value } = btn.dataset;
    toggle(active, group, value);
    btn.setAttribute('aria-pressed', active[group].has(value) ? 'true' : 'false');
    document.getElementById('coatFilter').classList.toggle('on', isActive(active));
    redraw(store.get());
  });

  unsubscribe = store.subscribe(redraw);
}

/**
 * Put a "you are here" dot on the map.
 *
 * A one-shot converged fix rather than a live watchPosition: the dot only has to answer
 * "am I near that pin", and holding the GPS on for the whole session to keep it perfect
 * costs battery on the device she is out walking with.
 */
function locateMe() {
  if (locating !== null) locating.cancel();
  locating = startLocating();
  locating.result.then((fix) => {
    if (map === null) return;
    const at = [fix.lat, fix.lon];

    if (meMarker === null) {
      meMarker = L.marker(at, {
        keyboard: false,
        // Its own pane would be overkill; a high offset is enough because this is one
        // marker and it must always win against photo pins.
        zIndexOffset: 1000,
        icon: L.divIcon({ className: 'me-dot', html: '<i></i>', iconSize: [18, 18], iconAnchor: [9, 9] }),
      }).addTo(map);
      meCircle = L.circle(at, { radius: fix.accuracyM, interactive: false, className: 'me-ring' }).addTo(map);
    } else {
      meMarker.setLatLng(at);
      meCircle.setLatLng(at).setRadius(fix.accuracyM);
    }
  }).catch((err) => {
    // Denied or unavailable is not an error state for the map — it just has no dot.
    console.warn('[map] location unavailable:', err.message);
  });
}

function redraw(state) {
  if (map === null) return;
  drawTurf(state);
  drawPins(state);
  renderBanner(state);
  renderEmpty(state);
}

export function onShown() {
  if (map !== null) map.invalidateSize();
}

export function unmount() {
  window.removeEventListener(TILE_CHANGED, applyTileSource);
  if (mapSizer !== null) { mapSizer.disconnect(); mapSizer = null; }
  lastTap = null;
  if (unsubscribe !== null) { unsubscribe(); unsubscribe = null; }
  if (locating !== null) { locating.cancel(); locating = null; }
  meMarker = null;
  meCircle = null;
  for (const g of Object.values(active)) g.clear();
  for (const url of objectUrls) URL.revokeObjectURL(url);
  objectUrls.clear();
  markers.clear();
  turfLayers = [];
  tileLayer = null;
  if (map !== null) { map.remove(); map = null; }
}
