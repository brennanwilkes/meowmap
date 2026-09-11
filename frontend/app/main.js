import { $ } from './dom.js';
import * as store from './store.js';
import * as mapPage from './map_page.js';

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

// Snap and Cats are placeholders until their pages land; keeping them as real page
// modules from the start means the router never needs changing to add them.
const placeholder = (text) => ({
  mount(el) { el.innerHTML = `<div class="pad"><p class="empty">${text}</p></div>`; },
  unmount() {},
});

const PAGES = {
  map: mapPage,
  snap: placeholder('Taking photos lands here next.'),
  cats: placeholder('Your cats will appear here.'),
};

let current = null;

function screenEl(name) {
  return $(`#s-${name}`);
}

/**
 * Page turn: sheets sliding across a desk. The incoming page is placed off-screen with
 * transitions OFF, a reflow commits that position, then the transition is re-enabled —
 * without the forced reflow the browser coalesces both states and nothing animates.
 */
function go(next) {
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
  location.hash = `#/${next}`;
  if (PAGES[next].onShown !== undefined) PAGES[next].onShown();
}

function screenFromHash() {
  const name = location.hash.replace(/^#\/?/, '').split('/')[0];
  return SCREENS.includes(name) ? name : 'map';
}

$('#tabs').addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (btn === null) return;
  go(btn.dataset.screen);
});

window.addEventListener('hashchange', () => go(screenFromHash()));

// Cheap to call and a 304 costs the server one row read, so refresh on every return to
// the app rather than polling on a timer.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') store.refresh();
});
window.addEventListener('online', () => store.refresh());

go(screenFromHash());
store.refresh();
