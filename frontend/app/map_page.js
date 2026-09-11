import {
  DEFAULT_TILE_ID, DEFAULT_ZOOM, FALLBACK_CENTRE, LS, TILE_SOURCES,
} from '../config.js';
import { esc } from './dom.js';
import { getJsonPref, getPref, setJsonPref } from './device.js';
import { photoUrl } from './api.js';
import * as store from './store.js';
import { ringFor } from './catcolor.js';
import { TURF_MIN_ZOOM, shouldDrawTurf, turfRing } from './turf.js';
import { displayName } from './catcolor.js';
import { openSightingSheet } from './sheet.js';

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

function tileSource() {
  const id = getPref(LS.tileSource, DEFAULT_TILE_ID);
  return TILE_SOURCES.find((t) => t.id === id) ?? TILE_SOURCES[0];
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

  const badge = count > 1 ? `<b>&times;${count}</b>` : (s.pending === true ? '<b>!</b>' : '');
  return L.divIcon({
    className: cls.join(' '),
    html: `<i style="--ring:${esc(ring)};background-image:url(${esc(thumbSrc(s))})"></i>${badge}`,
    iconSize: [46, 46],
    iconAnchor: [23, 55],
  });
}

/**
 * Collapse sightings of the SAME cat within ~15 m into one pin with a count.
 *
 * Deliberately not generic marker clustering: a cat photographed on the same fence
 * eight times should be one pin, but two different cats on one doorstep must stay two
 * pins. Clustering by screen proximity gets that backwards, and it would need a plugin.
 */
function collapse(sightings) {
  const groups = [];
  const MERGE_DEG = 15 / 111_320;   // ~15 m
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
  for (const cat of store.catsWithSightings(state)) {
    const pts = cat.sightings.map((s) => [s.lat, s.lon]);
    const ring = ringFor(cat.id);

    if (!shouldDrawTurf(pts.length)) {
      // Two sightings is a line; connector lines past four or five turn to spaghetti,
      // which is why three earns a territory instead.
      if (pts.length === 2) {
        turfLayers.push(L.polyline(pts, {
          color: ring, weight: 3, dashArray: '6 6', opacity: .9, interactive: false,
        }).addTo(map));
      }
      continue;
    }

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

function drawPins(state) {
  const groups = collapse(store.renderableSightings(state));
  const seen = new Set();

  for (const g of groups) {
    const head = g.members[0];
    const key = `${g.key}@${g.lat.toFixed(5)},${g.lon.toFixed(5)}`;
    seen.add(key);

    const ring = head.pending === true ? 'var(--marigold)' : ringFor(head.catId);
    const icon = pinIcon(head, ring, g.members.length);

    const existing = markers.get(key);
    if (existing !== undefined) {
      existing.setLatLng([g.lat, g.lon]);
      existing.setIcon(icon);
      existing.off('click');
      existing.on('click', () => openSightingSheet(head, store.catById(head.catId, state), g.members));
      continue;
    }
    const m = L.marker([g.lat, g.lon], { icon })
      .addTo(map)
      .on('click', () => openSightingSheet(head, store.catById(head.catId, state), g.members));
    markers.set(key, m);
  }

  for (const [key, m] of markers) {
    if (!seen.has(key)) { map.removeLayer(m); markers.delete(key); }
  }
}

function renderBanner(state) {
  const el = document.getElementById('outboxBanner');
  if (el === null) return;
  const n = state.pending.length;
  if (n === 0) { el.style.display = 'none'; return; }
  el.style.display = '';
  el.textContent = n === 1
    ? '1 photo still to upload — keep the app open'
    : `${n} photos still to upload — keep the app open`;
}

export function mount(el) {
  el.innerHTML = `
    <div id="map"></div>
    <div class="outbox-banner" id="outboxBanner" style="display:none"></div>`;

  const view = getJsonPref(LS.lastView, null);
  const centre = view === null ? [FALLBACK_CENTRE.lat, FALLBACK_CENTRE.lon] : [view.lat, view.lon];
  const zoom = view === null ? DEFAULT_ZOOM : view.zoom;

  map = L.map('map', {
    zoomControl: false,
    attributionControl: true,
    preferCanvas: true,
  }).setView(centre, zoom);

  map.createPane('turf');
  map.getPane('turf').style.zIndex = '650';

  const src = tileSource();
  tileLayer = L.tileLayer(src.url, {
    attribution: src.attribution,
    maxZoom: src.maxZoom,
    maxNativeZoom: src.maxNativeZoom,
    subdomains: src.subdomains ?? 'abc',
  }).addTo(map);

  // The container was written by innerHTML a moment ago and may not have laid out yet.
  requestAnimationFrame(() => { if (map !== null) map.invalidateSize(); });

  map.on('zoomend', updateTurfLabels);
  map.on('moveend', () => {
    const c = map.getCenter();
    setJsonPref(LS.lastView, { lat: c.lat, lon: c.lng, zoom: map.getZoom() });
  });

  unsubscribe = store.subscribe((state) => {
    if (map === null) return;
    drawTurf(state);
    drawPins(state);
    renderBanner(state);
  });
}

export function onShown() {
  if (map !== null) map.invalidateSize();
}

export function unmount() {
  if (unsubscribe !== null) { unsubscribe(); unsubscribe = null; }
  for (const url of objectUrls) URL.revokeObjectURL(url);
  objectUrls.clear();
  markers.clear();
  turfLayers = [];
  tileLayer = null;
  if (map !== null) { map.remove(); map = null; }
}
