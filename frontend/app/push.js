import { LS, VAPID_PUBLIC_KEY } from '../config.js';
import { NeedsPassError, deletePushSubscription, savePushSubscription } from './api.js';
import { getPref, setPref } from './device.js';
import { isStandalone } from './pwa.js';
import * as turnstile from './turnstile.js';

/* "Tell me when a cat is added", for THIS phone.
 *
 * Each phone turns it on for itself. The Worker decides who hears about an upload
 * (everyone subscribed except the person who sent it); this module only keeps this
 * phone's subscription and the Worker's copy of it in step.
 *
 * iOS delivers Web Push only to an app opened from the Home Screen, and shows the
 * permission prompt only from inside a tap. A Safari tab has no PushManager at all. */

function keyBytes() {
  const b64 = VAPID_PUBLIC_KEY.replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4)), (c) => c.charCodeAt(0));
}

/** One retry through a fresh challenge on a 401, the same as every other mutation. */
async function authed(call) {
  await turnstile.ensurePass();
  try {
    return await call();
  } catch (err) {
    if (!(err instanceof NeedsPassError)) throw err;
    await turnstile.renewPass();
    return await call();
  }
}

/** @returns {'needs-install'|'unsupported'|'denied'|'on'|'off'} */
export async function status() {
  const supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  if (!supported) return isStandalone() ? 'unsupported' : 'needs-install';
  if (Notification.permission === 'denied') return 'denied';
  const reg = await navigator.serviceWorker.ready;
  return (await reg.pushManager.getSubscription()) === null ? 'off' : 'on';
}

/** MUST be called straight from the tap handler: the permission request is the first
 *  thing it does, before any await, because iOS ignores one made outside the gesture. */
export async function enable() {
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return;
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes() });
  try {
    await authed(() => savePushSubscription(sub.toJSON()));
  } catch (err) {
    // A subscription the Worker never heard about would read "on" here and deliver
    // nothing, forever. Better to stay visibly off and let her try again.
    await sub.unsubscribe();
    throw err;
  }
  setPref(LS.pushEndpoint, sub.endpoint);
}

/** Server first: if that fails she is still subscribed on both ends, which is a state
 *  the toggle can show truthfully. */
export async function disable() {
  await authed(() => deletePushSubscription());
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  if (sub !== null) await sub.unsubscribe();
}

/** Once per launch. A push service may rotate the endpoint without telling anyone, and a
 *  device whose storage was cleared comes back under a new id, so either way the Worker
 *  needs the current one. Only a CHANGED endpoint is sent, so a normal launch costs no
 *  request and no D1 write. */
export async function resync() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  if (sub === null || sub.endpoint === getPref(LS.pushEndpoint, null)) return;
  await authed(() => savePushSubscription(sub.toJSON()));
  setPref(LS.pushEndpoint, sub.endpoint);
}
