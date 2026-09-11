import { DEFAULT_TILE_ID, LS, TILE_SOURCES } from '../config.js';
import { getHealth } from './api.js';
import { deviceId, getPref, setPref } from './device.js';
import { $, esc, whenText } from './dom.js';
import { back } from './nav.js';
import { storageReport } from './pwa.js';
import * as flush from './flush.js';
import * as outbox from './outbox.js';
import * as store from './store.js';

/* Settings, and more usefully: the diagnostics page.
 *
 * Everything here answers a question that is otherwise unanswerable from a phone —
 * is my photo safe, is the tile provider lying to me, how close is the cost breaker.
 */

let root = null;
let unsubscribe = null;

function bytes(n) {
  if (n === null || n === undefined) return '—';
  if (n < 1e6) return `${Math.round(n / 1e3)} KB`;
  if (n < 1e9) return `${(n / 1e6).toFixed(1)} MB`;
  return `${(n / 1e9).toFixed(2)} GB`;
}

function bar(used, ceiling) {
  const pct = ceiling === 0 ? 0 : Math.min(100, (used / ceiling) * 100);
  const state = pct > 90 ? 'hot' : pct > 65 ? 'warm' : 'cool';
  return `<span class="meter" data-state="${state}"><i style="width:${pct.toFixed(1)}%"></i></span>`;
}

function render(state) {
  const chosen = getPref(LS.tileSource, DEFAULT_TILE_ID);
  const queued = state.pending;

  root.innerHTML = `
    <div class="pad">
      <div class="detail-head">
        <button type="button" class="btn-ghost" id="back">Back</button>
      </div>

      <h2 class="sec">Map style</h2>
      <p class="hand">if the map ever says "API KEY REQUIRED", switch it here</p>
      <div class="chiprow" id="tiles">
        ${TILE_SOURCES.map((t, i) => `
          <button type="button" class="chip" data-tile="${esc(t.id)}"
                  aria-pressed="${t.id === chosen ? 'true' : 'false'}"
                  style="--fill:var(--jade);--tilt:${i % 2 === 0 ? '-2deg' : '1.5deg'}"
                  >${esc(t.label)}</button>`).join('')}
      </div>

      <hr class="rule">
      <h2 class="sec">Waiting to upload</h2>
      <div id="queue">${queueView(queued)}</div>

      <hr class="rule">
      <h2 class="sec">This phone</h2>
      <dl class="facts" id="storage"><dt>Storage</dt><dd>checking…</dd></dl>

      <hr class="rule">
      <h2 class="sec">Server</h2>
      <dl class="facts" id="health"><dt>Status</dt><dd>checking…</dd></dl>

      <hr class="rule">
      <p class="fineprint">
        Uploads log your IP address and browser for abuse prevention.<br>
        Device id <code>${esc(deviceId())}</code>
      </p>
    </div>`;

  wire();
  loadStorage();
  loadHealth();
}

function queueView(rows) {
  if (rows.length === 0) return '<p class="empty">Nothing waiting. Everything is uploaded.</p>';
  return rows.map((r) => `
    <div class="queue-row" data-client="${esc(r.clientId)}">
      <span class="q-when">${esc(whenText(r.createdAt))}</span>
      <span class="q-state" data-state="${esc(r.state)}">
        ${r.state === outbox.STATE.failed
          ? `could not upload${r.lastError === null ? '' : ` — ${esc(r.lastError)}`}`
          : `attempt ${r.attempts + 1}`}
      </span>
      <span class="q-acts">
        <button type="button" class="btn-ghost sm" data-act="save">Save to phone</button>
        <button type="button" class="btn-ghost sm" data-act="retry">Retry</button>
        ${r.state === outbox.STATE.failed
          ? '<button type="button" class="btn-ghost sm danger" data-act="discard">Discard</button>'
          : ''}
      </span>
    </div>`).join('');
}

function wire() {
  $('#back', root).addEventListener('click', () => back());

  $('#tiles', root).addEventListener('click', (e) => {
    const btn = e.target.closest('[data-tile]');
    if (btn === null) return;
    setPref(LS.tileSource, btn.dataset.tile);
    for (const sib of root.querySelectorAll('[data-tile]')) {
      sib.setAttribute('aria-pressed', String(sib.dataset.tile === btn.dataset.tile));
    }
  });

  $('#queue', root).addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]');
    if (act === null) return;
    const clientId = act.closest('[data-client]').dataset.client;
    // "Save to phone" is the escape hatch that makes a terminal failure survivable: an
    // in-app camera photo never reaches the camera roll on its own.
    if (act.dataset.act === 'save') flush.downloadCopy(clientId).catch(console.error);
    if (act.dataset.act === 'retry') flush.retry(clientId).catch(console.error);
    if (act.dataset.act === 'discard') {
      if (act.dataset.armed !== 'true') {
        act.dataset.armed = 'true';
        act.textContent = 'Sure?';
        setTimeout(() => {
          if (act.isConnected) { act.dataset.armed = 'false'; act.textContent = 'Discard'; }
        }, 4000);
        return;
      }
      flush.discard(clientId).catch(console.error);
    }
  });
}

async function loadStorage() {
  const el = $('#storage', root);
  const r = await storageReport();
  if (!el.isConnected) return;
  el.innerHTML = `
    <dt>Photos kept safe</dt>
    <dd class="${r.persisted ? 'good' : 'warn'}">
      ${r.persisted
        ? 'Yes — iOS will not evict them'
        : 'NOT GUARANTEED. Add Meowmap to your home screen and reopen this page.'}
    </dd>
    <dt>Installed</dt><dd>${r.standalone ? 'Yes' : 'No — running in Safari'}</dd>
    <dt>Used</dt><dd>${esc(bytes(r.usage))} of ${esc(bytes(r.quota))}</dd>`;
}

async function loadHealth() {
  const el = $('#health', root);
  try {
    const h = await getHealth();
    if (!el.isConnected) return;
    const b = h.budget;
    el.innerHTML = `
      <dt>Photo storage</dt>
      <dd class="${b.storageBlocked ? 'warn' : ''}">${bar(b.bytesUsed, b.bytesCeiling)}
        ${esc(bytes(b.bytesUsed))} of ${esc(bytes(b.bytesCeiling))}</dd>
      <dt>Photo views this month</dt>
      <dd class="${b.readsBlocked ? 'warn' : ''}">${bar(b.readsEstimated, b.readsCeiling)}
        ${b.readsEstimated.toLocaleString()} of ${b.readsCeiling.toLocaleString()}
        <em>(estimated by 1-in-100 sampling)</em></dd>
      <dt>Uploads today</dt>
      <dd class="${b.uploadsBlocked ? 'warn' : ''}">${bar(b.uploadsToday, b.uploadsCeiling)}
        ${b.uploadsToday} of ${b.uploadsCeiling}</dd>
      <dt>Photos stored</dt><dd>${b.objects.toLocaleString()}</dd>`;
  } catch (err) {
    if (!el.isConnected) return;
    el.innerHTML = `<dt>Status</dt><dd class="warn">${esc(err.message)}</dd>`;
  }
}

export function mount(container) {
  root = container;
  unsubscribe = store.subscribe(render);
}

export function unmount() {
  if (unsubscribe !== null) { unsubscribe(); unsubscribe = null; }
  root = null;
}
