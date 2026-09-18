import { $ } from './dom.js';
import { back } from './nav.js';
import * as store from './store.js';
import * as mapPage from './map_page.js';
import * as capturePage from './capture_page.js';
import * as catsPage from './cats_page.js';
import * as catPage from './cat_page.js';
import * as sightingPage from './sighting_page.js';
import * as settingsPage from './settings_page.js';
import * as turnstile from './turnstile.js';
import * as flush from './flush.js';
import * as pwa from './pwa.js';

/* Router and app-shell lifecycle.
 *
 * Page contract: every page module exports mount(container) and unmount(). unmount()
 * MUST release every subscription, listener, object URL and the Leaflet instance —
 * leaking object URLs in a photo app is how you OOM an iPhone. */

/* Routable screens, in left-to-right order — `go()` reads this to pick the page-turn
 * direction. `snap` is still a screen (it renders the draft) but NOT a tab: capture is
 * an action fired from the nav glyphs, and arriving at it without a photo bounces to the
 * map. See capture_page.openPicker. */
const SCREENS = ['map', 'snap', 'cats'];

/* The wordmark is CONSTANT. It used to change per page, with a faint subtitle beside it
 * — but the tab bar and the content already say where you are, so the header was
 * restating it, and a wordmark that changes is not a wordmark. It is set once in
 * index.html and never touched. */

const PAGES = {
  map: mapPage,
  snap: capturePage,
  cats: catsPage,
};

/* Detail routes live on their own layer over the tabs. Each takes the trailing hash
 * segment as its argument; settings takes none. */
const DETAILS = {
  cat: catPage,
  sighting: sightingPage,
  settings: settingsPage,
};

let current = null;
let detail = null;   // { name, arg } or null

function screenEl(name) {
  return $(`#s-${name}`);
}

/**
 * Page turn: sheets sliding across a desk. The incoming page is placed off-screen with
 * transitions OFF, a reflow commits that position, then the transition is re-enabled —
 * without the forced reflow the browser coalesces both states and nothing animates.
 */
function go(next, keepHash = false) {
  if (next === current) return;
  const to = screenEl(next);
  const from = current === null ? null : screenEl(current);
  const forward = from === null || SCREENS.indexOf(next) > SCREENS.indexOf(current);

  if (current !== null) PAGES[current].unmount();
  PAGES[next].mount(to);

  to.classList.remove('hide', 'rest-l', 'rest-r', 'live');
  if (from !== null) {
    to.classList.add(forward ? 'set-r' : 'set-l');
    void to.offsetWidth;
    to.classList.remove('set-r', 'set-l');
  }
  to.classList.add('live');

  if (from !== null) {
    from.classList.remove('live');
    from.classList.add(forward ? 'rest-l' : 'rest-r');
    setTimeout(() => {
      if (!from.classList.contains('live')) from.classList.add('hide');
    }, 320);
  }

    for (const btn of document.querySelectorAll('#tabs button')) {
    if (btn.dataset.screen === next) btn.setAttribute('aria-current', 'page');
    else btn.removeAttribute('aria-current');
  }

  current = next;
  // Always revalidate on arriving at a tab. It is a conditional GET: unchanged costs the
  // server one row read and us nothing, so there is no reason to show a stale map.
  store.refresh();
  // keepHash is for a cold load straight onto a detail URL: the tab underneath must be
  // mounted, but writing the hash here would navigate away from the detail route before
  // it ever opened.
  if (!keepHash && location.hash !== `#/${next}`) location.hash = `#/${next}`;
  if (PAGES[next].onShown !== undefined) PAGES[next].onShown();
}

/* ── the detail layer ──────────────────────────────────────────────────── */

function openDetail(name, arg) {
  const el = $('#s-detail');
  const body = $('#s-detail-body');
  const wasOpen = detail !== null;
  if (wasOpen) DETAILS[detail.name].unmount();

  /* `detail` is set BEFORE mount, and mount is guarded.
   *
   * It used to be set after. If a page's mount() threw, the sheet had already been made
   * visible but `detail` was still null, so closeDetail() returned early and NOTHING
   * could dismiss it — a blank panel stuck over the app until a reload. Recording that
   * the layer is open is not the page's success story, it is the layer's own state. */
  detail = { name, arg };

  el.style.transform = '';
  el.classList.remove('hide', 'down');
  $('#detail-veil').classList.add('on');
  // The nav compacts while a sheet is up; see .tabs in layout.css.
  document.body.classList.add('sheet-up');
  if (!wasOpen) {
    el.classList.add('set-up');
    void el.offsetWidth;          // commit the off-screen position before transitioning
    el.classList.remove('set-up');
  }
  
  try {
    DETAILS[name].mount(body, arg);
    if (DETAILS[name].onShown !== undefined) DETAILS[name].onShown();
  } catch (err) {
    console.error(`[router] ${name} failed to mount:`, err);
    body.innerHTML = `<div class="pad"><p class="empty">This page could not open.</p>
      <p class="hand">swipe down to go back</p></div>`;
  }
}

function closeDetail() {
  const el = $('#s-detail');
  // Hide unconditionally, even if `detail` is somehow null: this is the only escape
  // hatch, so it must not depend on the bookkeeping being right.
  if (detail !== null) {
    try { DETAILS[detail.name].unmount(); } catch (err) { console.error('[router] unmount:', err); }
  }
  detail = null;
  el.style.transform = '';
  // Restore the tab's own title: the detail layer borrowed the topbar, it does not own it.
  if (current !== null) {
      }
  el.classList.add('down');
  $('#detail-veil').classList.remove('on');
  document.body.classList.remove('sheet-up');
  setTimeout(() => { if (detail === null) el.classList.add('hide'); }, 320);
}

/* ── routing ───────────────────────────────────────────────────────────── */

function route() {
  const parts = location.hash.replace(/^#\/?/, '').split('/');
  const head = parts[0];

  if (Object.prototype.hasOwnProperty.call(DETAILS, head)) {
    // The tab underneath stays mounted: closing a detail must not re-run a map build.
    if (current === null) go('map', true);
    openDetail(head, parts[1] === undefined ? null : parts[1]);
    return;
  }
  closeDetail();
  /* #/snap is a screen but not a destination: it renders a photo that has just been
   * picked. Landing there without one — a cold load on the URL, or a bounce after a
   * discard — goes to the map instead. */
  if (head === 'snap' && !capturePage.hasQueued()) { go('map'); return; }
  go(SCREENS.includes(head) ? head : 'map');
}

/* ONE handler for the whole nav, because the two kinds of control are not the same
 * kind of thing and the second listener must not see the first's buttons.
 *
 * It was two listeners, and the glyphs have no `data-screen`: tapping the camera fired
 * the picker AND `go(undefined)`, which unmounted the map and then threw on
 * `PAGES[undefined]`. The app was already broken before the camera had even opened —
 * the empty screen only became visible on the way back from it.
 *
 * `openPicker` clicks the hidden input SYNCHRONOUSLY inside this handler; nothing may be
 * awaited between the tap and that call, or iOS silently drops the picker. */
$('#tabs').addEventListener('click', (e) => {
  const act = e.target.closest('[data-pick]');
  if (act !== null) { capturePage.openPicker(act.dataset.pick); return; }
  const btn = e.target.closest('[data-screen]');
  if (btn === null) return;
  go(btn.dataset.screen);
});

window.addEventListener('hashchange', route);

/* Settings over an already-open detail SWAPS it rather than stacking on it — see
 * navigate() in nav.js. Otherwise closing Settings dropped her back onto the cat page she
 * had opened it from, which is not where she was heading. */
$('#cog').addEventListener('click', () => {
  if (detail !== null) { location.replace('#/settings'); return; }
  location.hash = '#/settings';
});

/* ── swipe the detail sheet back down ──────────────────────────────────── */

/* There is no Back button on a detail page: the gesture IS the affordance, which is why
 * the sheet stops short of the top edge and wears a grabber. Two rules make it not fight
 * the page underneath it:
 *   - a drag only starts at the grabber, or when the content is scrolled to the very top;
 *   - once a vertical drag is committed the page must not also scroll, so the move
 *     handler is non-passive and calls preventDefault.
 *
 * THREE THINGS MAKE IT FEEL NATIVE rather than jittery, and all three were wrong first:
 *
 *   1. The transform is written ONCE PER FRAME from a rAF, not on every touchmove. iOS
 *      fires touchmove faster than it paints, so writing straight from the handler queues
 *      several layout-affecting writes per frame and the sheet visibly stutters.
 *   2. Velocity is measured over the LAST ~100 ms, not the whole gesture. Averaging from
 *      touchstart means a quick flick followed by holding still still reads as fast, so
 *      the sheet flew away after she had already decided not to dismiss it — the "can't
 *      cancel mid-drag" complaint. Measuring recent motion makes stopping a real cancel.
 *   3. The committed threshold is SUBTRACTED from the offset. Deciding at 8px and then
 *      translating by the full 8 made the sheet jump under the finger at the exact moment
 *      it started tracking.
 *
 * Tracking is 1:1 downward, which is what every iOS sheet does; the earlier 0.85 factor
 * meant the sheet lagged behind the finger and never felt attached to it.
 */
const DISMISS_PX = 90;
const DISMISS_VELOCITY = 0.5;   // px/ms — a quick flick counts even if it is short
const COMMIT_PX = 8;            // slop before a drag is a drag rather than a tap
/* How much a downward drag has to out-measure a sideways one to dismiss the sheet when it
 * STARTED on the filmstrip. 1 would mean a swipe that drifts a degree past diagonal takes
 * the photo off the screen; anything much above 2 and the strip is effectively excluded
 * again, which is the thing being fixed. */
const STRIP_BIAS = 1.6;
const VELOCITY_WINDOW_MS = 100;

(() => {
  const el = $('#s-detail');
  let startY = 0;
  let startX = 0;
  let dragging = false;
  let decided = false;
  let biased = false;
  let offset = 0;
  let frame = 0;
  /* Recent samples only — anything older than the window is dropped, so `velocity` below
   * describes what the finger is doing NOW rather than what it did on the way here. */
  let samples = [];

  const paint = () => {
    frame = 0;
    el.style.transform = offset === 0 ? '' : `translateY(${offset}px)`;
  };

  const settle = () => {
    if (frame !== 0) { cancelAnimationFrame(frame); frame = 0; }
    el.style.transition = '';
    el.style.transform = '';
  };

  /* Is anything between the touch and the sheet actually scrolled down?
   *
   * The guard used to read `body.scrollTop`, but `#s-detail-body` IS NOT THE SCROLLER —
   * `.pad` inside it is (`height:100%; overflow-y:auto`). So it was always 0, the guard
   * never fired, and a downward drag halfway through a long page dismissed the sheet
   * instead of scrolling it. Walking up from the touch target finds whichever element is
   * actually scrolling, without this having to know the class name. */
  const scrolledDown = (node) => {
    for (let n = node; n !== null && n !== el.parentNode; n = n.parentElement) {
      if (n.scrollTop > 0) return true;
    }
    return false;
  };

  el.addEventListener('touchstart', (e) => {
    if (detail === null || e.touches.length !== 1) return;
    /* A LEAFLET MAP OWNS ITS OWN DRAG. Without this, panning a mini-map inside a detail
     * page drags the whole sheet down with it — the map pans, the sheet follows, and the
     * page appears to scroll on its own. Leaflet claims the touch outright, so it is the
     * one thing that has to be excluded rather than shared with. */
    if (e.target.closest('.leaflet-container') !== null) return;
    /* THE FILMSTRIP IS SHARED, NOT EXCLUDED. It used to be in the line above, and the
     * photograph is most of what is on a cat page — so the only place a downward swipe
     * did anything was the grabber, right at the top of the screen, which is a long reach
     * and completely undiscoverable. It was excluded because paging sideways with a bit
     * of downward drift used to dismiss the sheet; that was before the slop threshold and
     * the direction test existed, and they are what actually solve it. A touch starting
     * on the strip just has to clear a higher bar to count as vertical. */
    const strict = e.target.closest('.filmstrip') !== null;
    const fromGrab = e.target.closest('.grab') !== null;
    if (!fromGrab && scrolledDown(e.target)) return;
    startY = e.touches[0].clientY;
    startX = e.touches[0].clientX;
    biased = strict;
    dragging = true;
    decided = false;
    offset = 0;
    samples = [{ y: startY, t: e.timeStamp }];
    el.style.transition = 'none';
  }, { passive: true });

  el.addEventListener('touchmove', (e) => {
    if (!dragging) return;
    const y = e.touches[0].clientY;
    const dy = y - startY;

    if (!decided) {
      const dx = e.touches[0].clientX - startX;
      /* WAIT FOR REAL MOVEMENT BEFORE JUDGING DIRECTION. The first millimetre of any
       * gesture is noise, and comparing dx to dy across it is decided by jitter: a
       * genuine downward drag that happens to start 2px to the left reads as horizontal,
       * gets handed to the page, and — because `dragging` is then false for the rest of
       * the gesture — can never recover. That is what made the swipe-down feel dead.
       * Below the slop threshold, commit to nothing. */
      if (Math.abs(dx) < COMMIT_PX && Math.abs(dy) < COMMIT_PX) return;
      // Let a horizontal swipe or an upward pull go to the page untouched. On the
      // filmstrip the downward pull has to win by a clear margin, because that surface
      // has a real sideways gesture of its own to protect.
      const needed = biased ? Math.abs(dx) * STRIP_BIAS : Math.abs(dx);
      if (dy < 0 || Math.abs(dy) <= needed) {
        dragging = false; el.style.transition = ''; return;
      }
      decided = true;
    }
    e.preventDefault();

    samples.push({ y, t: e.timeStamp });
    while (samples.length > 2 && e.timeStamp - samples[0].t > VELOCITY_WINDOW_MS) samples.shift();

    // Never above the resting position: this gesture only ever pushes the sheet DOWN.
    offset = Math.max(0, dy - COMMIT_PX);
    if (frame === 0) frame = requestAnimationFrame(paint);
  }, { passive: false });

  const end = (e) => {
    if (!dragging) return;
    dragging = false;
    /* CANCEL THE PENDING PAINT FIRST, on every exit including the dismissing one.
     * `paint()` was queued from the last touchmove and only `settle()` cancelled it — so
     * on a dismiss it fired AFTER closeDetail() had cleared the inline transform and
     * wrote the finger's last offset straight back over `.down`. The sheet stuck halfway
     * down the screen with its veil already gone and nothing able to shift it. */
    if (frame !== 0) { cancelAnimationFrame(frame); frame = 0; }
    if (!decided) { settle(); return; }

    const last = samples[samples.length - 1];
    const first = samples[0];
    const dt = last.t - first.t;
    // Zero elapsed time means one sample: no recent motion, so no flick.
    const velocity = dt <= 0 ? 0 : (last.y - first.y) / dt;

    if (offset > DISMISS_PX || velocity > DISMISS_VELOCITY) {
      /* Hand the rest of the travel to CSS from wherever the finger left it, so the
       * dismissal continues the gesture instead of restarting it. Restoring the
       * transition BEFORE back() is the whole trick: closeDetail() adds .down and clears
       * the inline transform, and with the transition live that animates from the
       * finger's last position to off-screen in one movement. */
      el.style.transition = '';
      back();
      return;
    }
    settle();
  };
  el.addEventListener('touchend', end, { passive: true });
  el.addEventListener('touchcancel', end, { passive: true });

  // The grabber is also a plain tap target: a gesture with no fallback strands anyone
  // who does not discover it, and it costs one listener.
  $('#detailGrab').addEventListener('click', () => { if (detail !== null) back(); });

  // Tapping the strip of page left showing above the sheet dismisses it, the way a
  // backdrop does. That strip exists precisely to say "there is something behind me".
  $('#detail-veil').addEventListener('click', () => { if (detail !== null) back(); });
})();

// Cheap to call and a 304 costs the server one row read, so refresh on every return to
// the app rather than polling on a timer.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') store.refresh();
});
window.addEventListener('online', () => store.refresh());

route();
store.refresh();

// A 401 during a background flush means the pass expired, not that anything is wrong.
// Registering the exchange here rather than in the capture page means a queue that
// drains hours later can still re-verify.
// renewPass, not ensurePass: a 401 means the pass we hold was REJECTED, so reusing the
// stored one would loop forever.
flush.onNeedsPass(turnstile.renewPass);

pwa.register();
// Ask every boot: persist() legitimately flips to granted once installed to the home
// screen, and the outbox is the only copy of an in-app camera photo.
pwa.ensurePersisted().then((s) => {
  if (!s.persisted) console.warn('[pwa] storage is NOT persisted', s);
});
// Boot the flush loop last: it resets interrupted uploads and immediately retries, so
// it must not race the first store.refresh().
flush.start().catch((err) => console.error('[flush] start failed:', err));
