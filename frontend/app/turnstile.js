import { exchangeTurnstileToken, getConfig } from './api.js';

/* The Turnstile → upload pass exchange.
 *
 * A 401 is NOT an error state. iOS ITP evicts localStorage after 7 idle days, so the
 * pass legitimately vanishes and "solve a challenge, retry" is a routine path — which is
 * why flush.js treats needs-pass as a retry rather than a failure.
 *
 * The script is loaded on demand rather than in index.html: most launches never mutate
 * anything, and a third-party script on the critical path of a map that must open fast
 * is a poor trade. Sliding renewal means a phone used more than once every 23 days
 * should see this exactly once, ever.
 */

const SCRIPT_URL = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

let scriptLoad = null;
let inFlight = null;

function loadScript() {
  if (scriptLoad !== null) return scriptLoad;
  scriptLoad = new Promise((resolve, reject) => {
    const el = document.createElement('script');
    el.src = SCRIPT_URL;
    el.async = true;
    el.onload = () => resolve();
    el.onerror = () => {
      // Let a later attempt retry rather than caching the failure forever — this fires
      // on a flaky connection as readily as on a blocked script.
      scriptLoad = null;
      reject(new Error('The verification service could not be reached.'));
    };
    document.head.appendChild(el);
  });
  return scriptLoad;
}

/**
 * Solve a challenge and store the resulting pass. Coalesced: several queued uploads
 * failing 401 at once must produce ONE challenge, not one each.
 */
export function ensurePass() {
  if (inFlight !== null) return inFlight;
  inFlight = run().finally(() => { inFlight = null; });
  return inFlight;
}

async function run() {
  const cfg = await getConfig();
  if (typeof cfg.turnstileSiteKey !== 'string' || cfg.turnstileSiteKey === '') {
    throw new Error('Uploads are not configured yet.');
  }
  await loadScript();

  const veil = document.createElement('div');
  veil.className = 'ts-veil';
  veil.innerHTML = `
    <div class="ts-card taped">
      <p class="ts-title">Just checking you are a person</p>
      <div class="ts-widget"></div>
      <p class="ts-note hand">This happens about once a month.</p>
    </div>`;
  document.body.appendChild(veil);

  try {
    const token = await new Promise((resolve, reject) => {
      window.turnstile.render(veil.querySelector('.ts-widget'), {
        sitekey: cfg.turnstileSiteKey,
        action: 'upload',
        // interaction-only: invisible unless Cloudflare actually wants an interaction,
        // which is the difference between a checkbox every time and one she never sees.
        appearance: 'interaction-only',
        callback: resolve,
        'error-callback': () => reject(new Error('Verification failed. Please try again.')),
        'expired-callback': () => reject(new Error('Verification expired. Please try again.')),
        'timeout-callback': () => reject(new Error('Verification timed out. Please try again.')),
      });
    });
    return await exchangeTurnstileToken(token);
  } finally {
    veil.remove();
  }
}
