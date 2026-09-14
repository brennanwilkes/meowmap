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

const SCREENS = ['map', 'snap', 'cats'];

const TITLES = {
  map: ['Meowmap', ''],
  snap: ['Snap', 'point it at a cat'],
  cats: ['Cats', ''],
};

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

const DETAIL_TITLES = {
  cat: ['Meowmap', 'a cat'],
  sighting: ['Meowmap', 'one sighting'],
  settings: ['Settings', ''],
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

  $('#wordmark').textContent = TITLES[next][0];
  $('#place').textContent = TITLES[next][1];
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
  if (detail !== null) DETAILS[detail.name].unmount();
  DETAILS[name].mount($('#s-detail-body'), arg);
  el.style.transform = '';

  el.classList.remove('hide', 'down');
  if (detail === null) {
    el.classList.add('set-up');
    void el.offsetWidth;          // commit the off-screen position before transitioning
    el.classList.remove('set-up');
  }
  detail = { name, arg };
  $('#wordmark').textContent = DETAIL_TITLES[name][0];
  $('#place').textContent = DETAIL_TITLES[name][1];
  if (DETAILS[name].onShown !== undefined) DETAILS[name].onShown();
}

function closeDetail() {
  if (detail === null) return;
  const el = $('#s-detail');
  DETAILS[detail.name].unmount();
  detail = null;
  el.style.transform = '';
  // Restore the tab's own title: the detail layer borrowed the topbar, it does not own it.
  if (current !== null) {
    $('#wordmark').textContent = TITLES[current][0];
    $('#place').textContent = TITLES[current][1];
  }
  el.classList.add('down');
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
  go(SCREENS.includes(head) ? head : 'map');
}

$('#tabs').addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (btn === null) return;
  go(btn.dataset.screen);
});

window.addEventListener('hashchange', route);

$('#cog').addEventListener('click', () => { location.hash = '#/settings'; });

/* ── swipe the detail sheet back down ──────────────────────────────────── */

/* There is no Back button on a detail page: the gesture IS the affordance, which is why
 * the sheet stops short of the top edge and wears a grabber. Two rules make it not fight
 * the page underneath it:
 *   - a drag only starts at the grabber, or when the body is scrolled to the very top;
 *   - once a vertical drag is committed the page must not also scroll, so the move
 *     handler is non-passive and calls preventDefault.
 */
const DISMISS_PX = 90;
const DISMISS_VELOCITY = 0.5;   // px/ms — a quick flick counts even if it is short

(() => {
  const el = $('#s-detail');
  const body = $('#s-detail-body');
  let startY = 0;
  let startX = 0;
  let startedAt = 0;
  let dragging = false;
  let decided = false;
  let fromGrab = false;

  el.addEventListener('touchstart', (e) => {
    if (detail === null || e.touches.length !== 1) return;
    fromGrab = e.target.closest('.grab') !== null;
    if (!fromGrab && body.scrollTop > 0) return;
    startY = e.touches[0].clientY;
    startX = e.touches[0].clientX;
    startedAt = e.timeStamp;
    dragging = true;
    decided = false;
    el.style.transition = 'none';
  }, { passive: true });

  el.addEventListener('touchmove', (e) => {
    if (!dragging) return;
    const dy = e.touches[0].clientY - startY;
    const dx = e.touches[0].clientX - startX;

    if (!decided) {
      // Let a horizontal swipe or an upward pull go to the page untouched.
      if (Math.abs(dx) > Math.abs(dy) || dy < 0) { dragging = false; el.style.transition = ''; return; }
      if (Math.abs(dy) < 8) return;
      decided = true;
    }
    e.preventDefault();
    // Resist slightly rather than tracking 1:1 — it reads as weight rather than slack.
    el.style.transform = `translateY(${dy * 0.85}px)`;
  }, { passive: false });

  const end = (e) => {
    if (!dragging) return;
    dragging = false;
    el.style.transition = '';
    const dy = (e.changedTouches?.[0]?.clientY ?? startY) - startY;
    const velocity = dy / Math.max(1, e.timeStamp - startedAt);
    if (decided && (dy > DISMISS_PX || velocity > DISMISS_VELOCITY)) {
      el.style.transform = '';
      back();
      return;
    }
    el.style.transform = '';
  };
  el.addEventListener('touchend', end, { passive: true });
  el.addEventListener('touchcancel', end, { passive: true });

  // The grabber is also a plain tap target: a gesture with no fallback strands anyone
  // who does not discover it, and it costs one listener.
  $('#detailGrab').addEventListener('click', () => { if (detail !== null) back(); });
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
