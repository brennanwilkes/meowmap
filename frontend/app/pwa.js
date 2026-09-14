import { LS } from '../config.js';
import { esc } from './dom.js';

/* Service worker registration, the update prompt, and storage persistence.
 *
 * PERSISTENCE IS THE DURABILITY-CRITICAL PART, not the offline caching. A photo taken
 * with the in-app camera never reaches the camera roll and originals are not kept, so
 * between capture and upload the IndexedDB outbox is the ONLY copy. Quota is not the
 * constraint (measured: 41 GB); eviction is.
 *
 * MEASURED: persist() was DENIED in Safari (standalone: false). WebKit's heuristic is
 * documented to favour installed home-screen apps, so the result is re-requested on
 * every boot rather than asked once — the answer legitimately changes after install.
 */

let updateReady = null;

export function register() {
  if (navigator.serviceWorker === undefined) return;

  // Registered relative to this module, so the GitHub Pages /meowmap/ subpath is picked
  // up automatically. An absolute '/sw.js' would 404 and silently disable the PWA.
  const url = new URL('../sw.js', import.meta.url);

  navigator.serviceWorker.register(url, { scope: './' }).then((reg) => {
    reg.addEventListener('updatefound', () => {
      const sw = reg.installing;
      if (sw === null) return;
      sw.addEventListener('statechange', () => {
        // A controller already exists ⇒ this is an update, not a first install.
        if (sw.state === 'installed' && navigator.serviceWorker.controller !== null) {
          updateReady = sw;
          showUpdateBar();
        }
      });
    });
  }).catch((err) => console.error('[pwa] registration failed:', err));

  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading) return;
    reloading = true;
    location.reload();
  });
}

/** Never swap ES module versions under a running page — she taps, then we reload. */
function showUpdateBar() {
  if (document.getElementById('update-bar') !== null) return;
  const bar = document.createElement('button');
  bar.id = 'update-bar';
  bar.className = 'update-bar';
  bar.textContent = 'A new version is ready — tap to reload';
  bar.addEventListener('click', () => {
    bar.disabled = true;
    if (updateReady !== null) updateReady.postMessage('SKIP_WAITING');
  });
  document.getElementById('app').appendChild(bar);
}

/* ── storage persistence ───────────────────────────────────────────────── */

export const isStandalone = () => window.navigator.standalone === true
  || window.matchMedia('(display-mode: standalone)').matches;

/**
 * Ask every boot. The answer is not stable across install, and the cost of asking is a
 * promise. Returns the state for Settings to display honestly.
 */
export async function ensurePersisted() {
  if (navigator.storage === undefined || navigator.storage.persist === undefined) {
    return { supported: false, persisted: false, standalone: isStandalone() };
  }
  let persisted = await navigator.storage.persisted();
  if (!persisted) persisted = await navigator.storage.persist();
  return { supported: true, persisted, standalone: isStandalone() };
}

/* ── the install nudge ─────────────────────────────────────────────────── */

/* iOS has no beforeinstallprompt, so installing cannot be offered as a button — it has
 * to be instructions. Shown once and never again: this is genuinely worth asking for
 * (it is what may flip persist() to granted), but a repeating banner in a photo app is
 * the fastest way to teach someone to ignore banners. */
export function maybeOfferInstall(container) {
  if (isStandalone()) return;
  if (localStorage.getItem(LS.installHintSeen) !== null) return;

  const card = document.createElement('div');
  card.className = 'install-hint taped';
  card.innerHTML = `
    <p>Add MeowMap to your home screen so photos stay safe while they wait to upload.</p>
    <p class="hand">Share ${esc('→')} Add to Home Screen</p>
    <button class="btn-stick sm" type="button">Got it</button>`;
  card.querySelector('button').addEventListener('click', () => {
    localStorage.setItem(LS.installHintSeen, String(Date.now()));
    card.remove();
  });
  container.appendChild(card);
}
