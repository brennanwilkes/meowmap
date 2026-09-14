import * as api from './api.js';

/* The single source of truth for cats and sightings.
 *
 * Store contract (same as vessel-tracker's): subscribe(fn) fires IMMEDIATELY and on
 * every change, and returns an unsubscribe. Firing immediately is what lets a page's
 * mount() be a pure render with no separate "load then draw" path. */

const listeners = new Set();

let state = {
  loaded: false,
  loading: false,
  error: null,
  etag: null,
  version: 0,
  cats: [],
  sightings: [],
  /** Outbox rows not yet on the server, rendered from local blobs. */
  pending: [],
};

export function get() {
  return state;
}

function emit() {
  for (const fn of listeners) fn(state);
}

function set(patch) {
  state = { ...state, ...patch };
  emit();
}

export function subscribe(fn) {
  listeners.add(fn);
  fn(state);
  return () => listeners.delete(fn);
}

/**
 * Refresh from the server. A 304 costs the server one row read and us nothing, so this
 * is cheap to call on every app open and visibility change.
 *
 * Never clears existing data on failure: offline is the normal case for this app, and
 * blanking the map because a fetch failed would be worse than showing stale pins.
 */
export async function refresh() {
  if (state.loading) return;
  set({ loading: true });
  try {
    const res = await api.getAll(state.etag);
    if (res.changed) {
      set({
        loaded: true, loading: false, error: null,
        etag: res.etag, version: res.version,
        cats: res.cats, sightings: res.sightings,
      });
    } else {
      set({ loaded: true, loading: false, error: null });
    }
  } catch (err) {
    set({ loading: false, error: err.message ?? 'Could not reach the server' });
  }
}

/** Called by the outbox so queued sightings appear on the map before they upload. */
export function setPending(rows) {
  set({ pending: rows });
}

/* ── derived views ─────────────────────────────────────────────────────── */

/**
 * Everything the map should draw.
 *
 * Dedupe is a hard API contract: the server echoes clientId on every sighting, and a
 * pending row is dropped once its clientId appears server-side. Without that echo the
 * map double-pins after every single upload.
 */
export function renderableSightings(s = state) {
  const serverIds = new Set(s.sightings.map((x) => x.clientId));
  const stillPending = s.pending.filter((p) => !serverIds.has(p.clientId));
  return [
    ...s.sightings.map((x) => ({ ...x, pending: false })),
    ...stillPending.map((p) => ({ ...p, pending: true })),
  ];
}

/** Cats with their sightings attached, for the list and the suggester. */
export function catsWithSightings(s = state) {
  const byCat = new Map();
  for (const sight of s.sightings) {
    // IDs can be 0, so this checks null explicitly.
    if (sight.catId === null || sight.catId === undefined) continue;
    if (!byCat.has(sight.catId)) byCat.set(sight.catId, []);
    byCat.get(sight.catId).push(sight);
  }
  return s.cats.map((cat) => ({ ...cat, sightings: byCat.get(cat.id) ?? [] }));
}

/**
 * Unidentified sightings, INCLUDING ones still queued for upload.
 *
 * Pending rows were originally excluded, which meant a photo that failed to upload was
 * drawn on the map but absent from the Cats page — the one place you would go looking
 * for it. A photo the app is holding must never be invisible anywhere it belongs.
 *
 * Pending rows have a clientId and no server id, so callers must key off `pending`
 * rather than assuming `id` exists.
 */
export function looseSightings(s = state) {
  return renderableSightings(s).filter((x) => x.catId === null || x.catId === undefined);
}

export function sightingById(id, s = state) {
  return s.sightings.find((x) => x.id === id) ?? null;
}

export function catById(id, s = state) {
  if (id === null || id === undefined) return null;
  return s.cats.find((c) => c.id === id) ?? null;
}
