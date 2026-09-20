// The map's live "you are here" watch. Local only, no framework:
//   node tests/geolocate.test.mjs
//
// Imports the REAL module so the test can never drift from what ships. The module reads
// the global `navigator`, which Node 22 provides read-only, so it is replaced outright.
import assert from 'node:assert';
import { GEO_ERROR, GeolocationFailure, watchLocation } from '../frontend/app/geolocate.js';

let pass = 0;
const check = (name, fn) => {
  try { fn(); pass++; }
  catch (e) { console.error(`FAIL  ${name}\n      ${e.message}`); process.exitCode = 1; }
};

const ORIGINAL = globalThis.navigator;
const stub = (geo) => Object.defineProperty(globalThis, 'navigator', {
  value: { geolocation: geo },
  configurable: true,
  writable: true,
});
const restore = () => Object.defineProperty(globalThis, 'navigator', {
  value: ORIGINAL,
  configurable: true,
  writable: true,
});

check('without geolocation the error surfaces and cancel is a no-op', () => {
  stub(undefined);
  const errs = [];
  const handle = watchLocation(() => assert.fail('no fix may fire'), (e) => errs.push(e));
  assert.strictEqual(errs.length, 1);
  assert.ok(errs[0] instanceof GeolocationFailure);
  assert.strictEqual(errs[0].kind, GEO_ERROR.unsupported);
  handle.cancel();
  assert.strictEqual(errs.length, 1, 'cancel must not call onError');
  restore();
});

check('every reading is forwarded as a dot position', () => {
  let watchId = null;
  let cb = null;
  const fires = [];
  stub({
    watchPosition(fn) { cb = fn; return (watchId = 42); },
    clearWatch() {},
  });
  const handle = watchLocation((f) => fires.push(f), () => assert.fail('no error expected'));
  assert.strictEqual(watchId, 42, 'watchPosition must be called, not getCurrentPosition');
  cb({ coords: { latitude: 48.4266, longitude: -123.3505, accuracy: 20 }, timestamp: 1234 });
  cb({ coords: { latitude: 48.4267, longitude: -123.3506, accuracy: 9.98 }, timestamp: 2345 });
  assert.deepStrictEqual(fires, [
    { lat: 48.4266, lon: -123.3505, accuracyM: 20, at: 1234 },
    { lat: 48.4267, lon: -123.3506, accuracyM: 9.98, at: 2345 },
  ], 'accuracy must arrive unrounded (the capture flow rounds where it lands)');
  handle.cancel();
  restore();
});

check('errors are routed to onError, not swallowed', () => {
  let errCb = null;
  const errs = [];
  stub({
    watchPosition(_, ecb) { errCb = ecb; return 7; },
    clearWatch() {},
  });
  watchLocation(() => assert.fail('no fix expected'), (e) => errs.push(e));
  errCb({ code: 1 });
  assert.strictEqual(errs.length, 1);
  assert.strictEqual(errs[0].kind, GEO_ERROR.denied);
  restore();
});

check('cancel stops the watch', () => {
  let watchId = null;
  const cleared = [];
  stub({
    watchPosition() { return (watchId = 99); },
    clearWatch(id) { cleared.push(id); },
  });
  const handle = watchLocation(() => {}, () => {});
  handle.cancel();
  handle.cancel();
  assert.deepStrictEqual(cleared, [99], 'the watch id, exactly once');
  restore();
});

console.log(`geolocate: ${pass} checks passed`);