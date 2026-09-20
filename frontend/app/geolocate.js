import { GEO_MAX_WAIT_MS, GEO_OPTIONS, GEO_TARGET_ACCURACY_M } from '../config.js';

/* Converging geolocation.
 *
 * Not a bare getCurrentPosition. `watchPosition` with maximumAge: 0 (load-bearing — she
 * is WALKING, and a fix from five minutes ago is a block away), keeping the best reading
 * and resolving early once it is good enough.
 *
 * MEASURED on iPhone 18.7.5: the first fix lands at ~1.2s reporting 20 m and then never
 * improves — five readings over 12 s were byte-identical. So in practice this resolves
 * on the first callback; the deadline exists for the device that behaves differently.
 *
 * If zero readings arrived, REJECT. Never resolve with a guess.
 */

export const GEO_ERROR = {
  denied: 'denied',
  unavailable: 'unavailable',
  timeout: 'timeout',
  unsupported: 'unsupported',
};

export class GeolocationFailure extends Error {
  constructor(kind, message) {
    super(message);
    this.name = 'GeolocationFailure';
    this.kind = kind;
  }
}

function describe(code) {
  if (code === 1) {
    return new GeolocationFailure(
      GEO_ERROR.denied,
      'Location is turned off for this app. Tap the map to place the pin instead.',
    );
  }
  if (code === 2) {
    return new GeolocationFailure(
      GEO_ERROR.unavailable,
      'Your phone could not get a location. Tap the map to place the pin instead.',
    );
  }
  return new GeolocationFailure(
    GEO_ERROR.timeout,
    'Finding your location took too long. Tap the map to place the pin instead.',
  );
}

/**
 * Start converging immediately and return a handle. Deliberately NOT a bare promise:
 * the capture flow starts this the moment the shutter is tapped, in parallel with the
 * picker and the resize, so the fix has those seconds to converge for free — and then
 * awaits `.result` only when it actually needs coordinates.
 */
export function startLocating() {
  if (navigator.geolocation === undefined) {
    const failed = Promise.reject(new GeolocationFailure(
      GEO_ERROR.unsupported,
      'This browser cannot provide a location. Tap the map to place the pin instead.',
    ));
    failed.catch(() => {});   // pre-attach: an unawaited handle must not warn
    return { result: failed, cancel() {} };
  }

  let best = null;
  let watchId = null;
  let deadline = null;
  let settle = null;

  const result = new Promise((resolve, reject) => {
    settle = (err) => {
      if (watchId !== null) { navigator.geolocation.clearWatch(watchId); watchId = null; }
      if (deadline !== null) { clearTimeout(deadline); deadline = null; }
      if (err !== null) { reject(err); return; }
      if (best === null) { reject(describe(3)); return; }
      resolve(best);
    };

    watchId = navigator.geolocation.watchPosition(
      (pos) => {
        const reading = {
          lat: pos.coords.latitude,
          lon: pos.coords.longitude,
          accuracyM: pos.coords.accuracy,
          at: pos.timestamp,
        };
        if (best === null || reading.accuracyM < best.accuracyM) best = reading;
        if (best.accuracyM <= GEO_TARGET_ACCURACY_M) settle(null);
      },
      (err) => {
        // A transient error after a good reading is not worth discarding it for.
        if (best !== null) { settle(null); return; }
        settle(describe(err.code));
      },
      GEO_OPTIONS,
    );

    deadline = setTimeout(() => settle(null), GEO_MAX_WAIT_MS);
  });

  result.catch(() => {});
  return {
    result,
    cancel() {
      if (watchId !== null) { navigator.geolocation.clearWatch(watchId); watchId = null; }
      if (deadline !== null) { clearTimeout(deadline); deadline = null; }
    },
  };
}

/**
 * Live position tracking for the map's "you are here" dot.
 *
 * Unlike startLocating, this DOES NOT settle: the watch stays on until cancel(),
 * forwarding every reading, so the dot can keep up with a walking cat-sighter.
 *
 * It is deliberately raw — no convergence, no minimum-accuracy holdout. The caller
 * decides what is worth applying (see map_page's movement threshold), and the first
 * reading can be the same 1-3 km cell estimate the capture flow's convergence exists to
 * filter: the map gates live fixes behind its converged first placement, so the dot is
 * never that block-off-then-leap.
 *
 * There is no promise, so nothing is handed back to await: errors go to onError for the
 * caller to decide whether they matter (a transient error after a dot already exists is
 * not a reason to delete it).
 */
export function watchLocation(onFix, onError) {
  if (navigator.geolocation === undefined) {
    onError(new GeolocationFailure(
      GEO_ERROR.unsupported,
      'This browser cannot provide a location. Tap the map to place the pin instead.',
    ));
    return { cancel() {} };
  }

  let watchId = null;
  watchId = navigator.geolocation.watchPosition(
    (pos) => onFix({
      lat: pos.coords.latitude,
      lon: pos.coords.longitude,
      accuracyM: pos.coords.accuracy,
      at: pos.timestamp,
    }),
    (err) => onError(describe(err.code)),
    GEO_OPTIONS,
  );

  return {
    cancel() {
      if (watchId !== null) { navigator.geolocation.clearWatch(watchId); watchId = null; }
    },
  };
}
