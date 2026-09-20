import {
  CLUSTER_MAX_RADIUS_M, CLUSTER_MIN_RADIUS_M, CLUSTER_RADIUS_AT_ZOOM,
  COAT_TAGS, DEFAULT_BOUNDS, DEFAULT_TILE_ID, GEO_TRACK_ACCURACY_GAIN_M,
  GEO_TRACK_MIN_MOVE_M, LS, PETTED_VALUES, SIZE_TAGS, TILE_CHANGED, TILE_SOURCES,
} from '../config.js';
import { esc } from './dom.js';
import { getJsonPref, getPref, setJsonPref } from './device.js';
import { photoUrl } from './api.js';
import * as pwa from './pwa.js';
import * as store from './store.js';
import { ringFor } from './catcolor.js';
import { distanceM } from './suggest.js';
import { TURF_MIN_ZOOM, shouldDrawTurf, turfRing } from './turf.js';
import { displayName } from './catcolor.js';
import { closeSheet, openSightingSheet } from './sheet.js';
import { emptyFilter, filterCats, filterSightings, isActive, toggle } from './filter.js';
import { startLocating, watchLocation } from './geolocate.js';

/* The map.
 *
 * Leaflet is a global from a classic <script>; never import it as a module.
 *
 * Render load is bounded by LAYER COUNT, not point count — that is the lesson from
 * vessel-tracker, where one long trail emitted ~750 polylines. Here every cat costs at
 * most one polygon plus one label plus its pins, so the budget is comfortable.
 *
 * BUT LAYER COUNT IS ONLY HALF OF IT: what matters as much is how often a layer is
 * REBUILT. `redraw` runs on every store emit — boot, `online`, each visibility change,
 * each mutation — and the first version tore down every turf blob and called `setIcon`
 * on every pin each time, whether anything had moved or not. `setIcon` discards the
 * divIcon's element and builds a new one, so each pass re-ran the background-image on
 * every print on the map; the cost scaled with the number of photos and bought nothing.
 * Both registries are therefore keyed AND SIGNED: a redraw that changes nothing must
 * touch no DOM at all. */

let map = null;
let unsubscribe = null;
let tileLayer = null;
/** Marker/layer registries, keyed so a refresh reuses rather than recreates. */
const markers = new Map();
/** cat id → { sig, layers }. Keyed and signed so a redraw that changes nothing
 *  touches no layers at all. */
const turfByCat = new Map();
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
/** The one-shot converged first fix, and the live watch that follows it. */
let locating = null;
let liveWatch = null;
/** The position and accuracy last APPLIED to the dot, for the movement threshold. */
let mePos = null;
let meAccuracy = null;

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

/* Keyed by clientId, NOT minted per call. `thumbSrc` runs from `pinIcon`, which runs
 * from every redraw, so an uncached createObjectURL leaked one blob URL per pending
 * photo per store emit — and the store emits twice per refresh, on every visibility
 * change. A stuck outbox plus a day of tab switching is how a phone runs out of
 * memory. Revoked in unmount() with everything else in `objectUrls`. */
const pendingUrls = new Map();

function thumbSrc(s) {
  if (s.pending === true) {
    // A queued sighting renders from its local bytes so it appears on the map the
    // instant it is taken, long before it uploads.
    const hit = pendingUrls.get(s.clientId);
    if (hit !== undefined) return hit;
    const url = URL.createObjectURL(new Blob([s.thumbBytes], { type: 'image/jpeg' }));
    objectUrls.add(url);
    pendingUrls.set(s.clientId, url);
    return url;
  }
  return photoUrl(s.photoThumb);
}

/* A pin is always the little polaroid, whatever the zoom — cluster collapse (see
 * `collapse` below) is what keeps the layer count down, not replacing the photo with a
 * dot. `count` is every print in the pile, `other` the number of OTHER cats beyond the
 * one shown (0 for a single cat's pile). */
function pinIcon(s, ring, count, other) {
  const cls = ['pin'];
  if (s.pending === true) cls.push('pending');
  else if (s.catId === null || s.catId === undefined) cls.push('loose');
  if (s.id % 2 === 1) cls.push('alt');

  if (count > 1) cls.push('stack');

  /* A stack of prints, not one print wearing a number: the count is the stamp on top and
   * <s> is the corner of the print underneath showing past it. Several photos collapsed
   * into one pin should LOOK like several photos before the number is read. A pile that
   * spans cats stamps the cats beyond the visible one (+N); a single cat's pile stamps
   * every print in it (×N). */
  const under = count > 1 ? '<s></s>' : '';
  let badge = '';
  if (other > 0) badge = `<b class="stamp round cross">+${other}</b>`;
  else if (count > 1) badge = `<b class="stamp round">&times;${count}</b>`;
  else if (s.pending === true) badge = '<b class="stamp round">!</b>';
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
 * Collapse sightings within `radiusM` into one pin, ACROSS cats. A 52 px pin at zoom 17
 * is ~40 m of ground; the same 52 px covers twice that at zoom 16, so the radius doubles
 * per level down (see CLUSTER_* in config.js) — merged exactly when the pins would
 * overlap on screen, which is what bounds the DOM layer count on a pan.
 *
 * Two prints of one cat on a fence collapse; so do two cats on the same block. The pile
 * keeps every member, the pin wears the TOP print's photo, and `other` is how many cats
 * beyond it the pile hides — "+1" instead of "×2" when the pile is not all one cat.
 */
function collapse(sightings, radiusM) {
  const groups = [];
  for (const s of sightings) {
    const hit = groups.find((g) => distanceM(g.lat, g.lon, s.lat, s.lon) < radiusM);
    if (hit === undefined) groups.push({ lat: s.lat, lon: s.lon, members: [s] });
    else hit.members.push(s);
  }
  for (const g of groups) {
    const cats = new Set(g.members.map((m) => (
      m.catId === null || m.catId === undefined ? `loose:${m.id ?? m.clientId}` : `cat:${m.catId}`
    )));
    g.other = cats.size - 1;
    /* The print ON TOP of the pile is the newest — a stack, not a queue — and its cat is
     * what the pin shows and what a tap opens. */
    g.head = g.members.reduce((a, b) => (b.seenAt > a.seenAt ? b : a));
  }
  return groups;
}

function drawTurf(state) {
  const seen = new Set();
  // Filtered here as well as in drawPins: a turf blob computed from points that are not
  // drawn is a shaded zone with nothing inside it.
  for (const cat of filterCats(store.catsWithSightings(state), active)) {
    const pts = cat.sightings.map((s) => [s.lat, s.lon]);

    // A lone sighting is just a pin; from the second onwards it earns a territory.
    if (!shouldDrawTurf(pts.length)) continue;
    seen.add(cat.id);

    /* Everything the drawn shape depends on, and nothing else. A blob is a 44-point
     * polygon plus a marker, and rebuilding it is the expensive half of a redraw —
     * so it is rebuilt only when one of these actually moved. */
    const sig = `${displayName(cat)}|${pts.map((p) => `${p[0]},${p[1]}`).join(';')}`;
    const held = turfByCat.get(cat.id);
    if (held !== undefined && held.sig === sig) continue;
    if (held !== undefined) for (const l of held.layers) map.removeLayer(l);

    const ring = ringFor(cat.id);
    const { ring: poly, centre } = turfRing(pts);
    const layers = [L.polygon(poly, {
      color: ring, weight: 2.5, dashArray: '7 7', opacity: .9,
      fillColor: ring, fillOpacity: 0.17, interactive: false, smoothFactor: 1,
    }).addTo(map)];

    /* NO LABEL ON AN UNNAMED CAT. The blob still draws — that is her territory either
     * way — but there is nothing to write on it, and the label used to read "'s turf"
     * with a blank where the name should be. */
    if (displayName(cat) !== '') {
      layers.push(
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
          // Read from the live store on tap rather than closing over this render's cat,
          // which would otherwise pin a whole sightings array in memory per redraw.
        }).addTo(map).on('click', () => {
          const c = store.catsWithSightings().find((x) => x.id === cat.id) ?? null;
          if (c === null || c.sightings.length === 0) return;
          openSightingSheet(c.sightings[0], c);
        }),
      );
    }
    turfByCat.set(cat.id, { sig, layers });
  }

  for (const [id, held] of turfByCat) {
    if (seen.has(id)) continue;
    for (const l of held.layers) map.removeLayer(l);
    turfByCat.delete(id);
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

/* WHAT THE PIN ACTUALLY LOOKS LIKE, as a string. `setIcon` on a divIcon throws the
 * element away and builds a new one, which re-runs the background-image on every print,
 * so calling it unconditionally meant every store emit rebuilt every pin on the map —
 * and the store emits twice per refresh, on boot, on `online`, and on every return to
 * the app. That is what made twenty photos feel like treacle: the work scaled with the
 * pin count and happened for no reason. Only a genuine change to this string is allowed
 * to touch the DOM. */
function pinSig(head, ring, count, other) {
  return `p|${ring}|${count}|${other}|${head.pending === true}|${head.catId}|${head.id}|${thumbSrc(head)}`;
}

function drawPins(state) {
  /* Cluster radius is a property of the ZOOM, not the data: a 52 px pin covers ~40 m of
   * ground at zoom 17 and twice that at 16, so the radius doubles per level down — the
   * exact point where the pins would start overlapping. NO floor: at zoom 18 the pin
   * covers only ~20 m, so two cats 25 m apart are already tappable separately and must
   * NOT stay merged behind a +1. Only the cap matters (see CLUSTER_* in config.js). */
  const radiusM = Math.min(CLUSTER_MAX_RADIUS_M,
    CLUSTER_MIN_RADIUS_M * 2 ** (CLUSTER_RADIUS_AT_ZOOM - map.getZoom()));
  const catsById = new Map(state.cats.map((c) => [c.id, c]));
  const groups = collapse(filterSightings(store.renderableSightings(state), catsById, active), radiusM);
  const seen = new Set();

  for (const g of groups) {
    const head = g.head;
    /* The registry key is the pile's MEMBERS, not a position: a cross-cat pile has no one
     * cat to key on, and the same set must resolve to the same key on any redraw or
     * setIcon fires for nothing. A pile that gains or loses a sighting is a different
     * pile and may rebuild — that is a real content change. */
    const key = `pile:${g.members
      .map((m) => (m.pending === true ? `p:${m.clientId}` : `s:${m.id}`))
      .sort().join(',')}`;
    seen.add(key);

    // A queued upload keeps the amber treatment; everything else gets its cat's colour,
    // or its own id's colour while it is still unidentified.
    const ring = head.pending === true
      ? 'var(--marigold)'
      : ringFor(head.catId, head.id ?? null);
    const count = g.members.length;
    const sig = pinSig(head, ring, count, g.other);

    const existing = markers.get(key);
    if (existing !== undefined) {
      /* The handler is attached ONCE and reads `entry.head`, rather than being detached
       * and re-attached every redraw around this render's closure. Rebinding a listener
       * per pin per emit is its own cost, and the old one captured `state` — so every
       * marker held a whole snapshot of the store alive. */
      existing.head = head;
      if (existing.sig !== sig) {
        existing.m.setIcon(pinIcon(head, ring, count, g.other));
        existing.sig = sig;
      }
      const ll = existing.m.getLatLng();
      if (ll.lat !== g.lat || ll.lng !== g.lon) existing.m.setLatLng([g.lat, g.lon]);
      continue;
    }
    const entry = { m: L.marker([g.lat, g.lon], { icon: pinIcon(head, ring, count, g.other) }), sig, head };
    entry.m.addTo(map).on('click', () => openSightingSheet(entry.head, catFor(entry.head, store.get())));
    markers.set(key, entry);
  }

  for (const [key, entry] of markers) {
    if (!seen.has(key)) { map.removeLayer(entry.m); markers.delete(key); }
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

  /* The cluster radius is a function of ZOOM (see drawPins), so crossing a zoom level
   * needs a recluster even though the store did not emit. Cheap when nothing changed:
   * pinSig carries the pile's content, so unchanged pins are left alone, and turf labels
   * early-exit on their own gate. */
  map.on('zoomend', () => {
    updateTurfLabels();
    drawPins(store.get());
  });
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
 * Put a "you are here" dot on the map and KEEP IT THERE.
 *
 * Two sources, one dot:
 *  1. The first fix CONVERGES exactly as capture's does — the initial reading is often
 *     a 1-3 km cell estimate with the good GPS fix landing 3-10 s later, and a dot that
 *     appears a block off and then leaps is worse than a dot that is a second late. The
 *     converged fix drops the dot, without moving the view.
 *  2. A live watch then keeps it moving as she walks. It does not apply its own first
 *     reading — that is the same cell estimate the convergence exists to filter — and it
 *     holds applications behind a movement threshold, because fixes arrive ~once a second
 *     and carry 10-20 m of GPS noise, so redrawing for each one makes a standing dot
 *     jitter. The dot is the one piece of position data on the map that has no reason to
 *     wait for a store refresh.
 *
 * The watch lives for the whole mount and is cancelled on unmount: switching tabs must
 * not leave the GPS on under an unmounted map.
 */
function locateMe() {
  stopLocating();
  mePos = null;
  meAccuracy = null;

  const place = (at, accuracyM) => {
    if (map === null) return;

    if (meMarker === null) {
      meMarker = L.marker(at, {
        keyboard: false,
        // Its own pane would be overkill; a high offset is enough because this is one
        // marker and it must always win against photo pins.
        zIndexOffset: 1000,
        icon: L.divIcon({ className: 'me-dot', html: '<i></i>', iconSize: [18, 18], iconAnchor: [9, 9] }),
      }).addTo(map);
      meCircle = L.circle(at, { radius: accuracyM, interactive: false, className: 'me-ring' }).addTo(map);
    } else {
      meMarker.setLatLng(at);
      meCircle.setLatLng(at).setRadius(accuracyM);
    }
  };

  const first = startLocating();
  locating = first;
  first.result.then((fix) => {
    mePos = [fix.lat, fix.lon];
    meAccuracy = fix.accuracyM;
    place(mePos, meAccuracy);
  }).catch((err) => {
    // Denied or unavailable is not an error state for the map — it just has no dot.
    console.warn('[map] location unavailable:', err.message);
  });

  liveWatch = watchLocation(
    (fix) => {
      // Gated on the first placement: the watch's opening reading can be the cell
      // estimate the convergence was added to filter.
      if (mePos === null || map === null) return;
      const movedM = distanceM(mePos[0], mePos[1], fix.lat, fix.lon);
      const ringChanged = meAccuracy !== null
        && Math.abs(fix.accuracyM - meAccuracy) >= GEO_TRACK_ACCURACY_GAIN_M;
      if (movedM < GEO_TRACK_MIN_MOVE_M && !ringChanged) return;
      mePos = [fix.lat, fix.lon];
      meAccuracy = fix.accuracyM;
      place(mePos, meAccuracy);
    },
    (err) => {
      // A transient error while walking is not a failure: keep the last fix on screen
      // and keep listening. Only the pre-dot denial earns the console.
      if (mePos === null) console.warn('[map] location unavailable:', err.message);
    },
  );
}

function stopLocating() {
  if (liveWatch !== null) { liveWatch.cancel(); liveWatch = null; }
  if (locating !== null) { locating.cancel(); locating = null; }
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
  /* THE SHEET IS A SHELL ELEMENT, NOT PART OF THIS PAGE. It is a sibling of every screen
   * at z-index 41, so an open one does not leave with the map — it hangs over whatever
   * comes next, and the capture form is where that was being seen: a pull-up of some
   * other cat appearing over the upload she was filling in, its photo missing because the
   * object URLs below were revoked out from under it on the way out. */
  closeSheet();
  window.removeEventListener(TILE_CHANGED, applyTileSource);
  if (mapSizer !== null) { mapSizer.disconnect(); mapSizer = null; }
  lastTap = null;
  if (unsubscribe !== null) { unsubscribe(); unsubscribe = null; }
  stopLocating();
  mePos = null;
  meAccuracy = null;
  meMarker = null;
  meCircle = null;
  for (const g of Object.values(active)) g.clear();
  for (const url of objectUrls) URL.revokeObjectURL(url);
  objectUrls.clear();
  markers.clear();
  turfByCat.clear();
  pendingUrls.clear();
  tileLayer = null;
  if (map !== null) { map.remove(); map = null; }
}
