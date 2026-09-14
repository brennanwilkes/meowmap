/* Everything renders through innerHTML template literals, so esc() on every interpolated
 * value is not optional. Note that `note` and cat `name` come straight from a public,
 * login-free endpoint — this is the XSS boundary for the whole app. */

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

/** For values going into an HTML attribute that is itself inside a template literal.
 *  Same escaping; a separate name so call sites read honestly. */
export const escAttr = esc;

/** Relative time, in the app's voice: short, lowercase, no "ago" padding where the
 *  word already implies it. */
export function whenText(ms, now = Date.now()) {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return '';
  const days = Math.floor((now - ms) / 86_400_000);
  if (days < 0) return 'just now';
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 14) return `${days} days ago`;
  if (days < 60) return 'last month';
  if (days < 365) return `${Math.round(days / 30)} months ago`;
  const years = Math.round(days / 365);
  return years === 1 ? 'a year ago' : `${years} years ago`;
}

/** Absolute date for the detail view: "September 4th 1:26pm", in the viewer's own zone.
 *  en-CA formats the day period as "p.m."; the app's voice is "pm", so the dots are
 *  stripped rather than the locale being fought.
 *
 *  Where this is shown, the relative "9 days ago" is NOT also shown — saying both is
 *  saying the same thing twice, and the absolute date is the one that answers a question
 *  she cannot work out for herself. */
export function dateText(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return '';
  const parts = new Intl.DateTimeFormat('en-CA', {
    day: 'numeric', month: 'long', hour: 'numeric', minute: '2-digit', hour12: true,
  }).formatToParts(new Date(ms));
  const get = (t) => parts.find((p) => p.type === t)?.value ?? '';
  const period = get('dayPeriod').toLowerCase().replace(/[^a-z]/g, '');
  return `${get('month')} ${get('day')}${ordinal(Number(get('day')))} ${get('hour')}:${get('minute')}${period}`;
}

/** "st/nd/rd/th". 11-13 are the exception that every naive version gets wrong. */
function ordinal(n) {
  if (n % 100 >= 11 && n % 100 <= 13) return 'th';
  if (n % 10 === 1) return 'st';
  if (n % 10 === 2) return 'nd';
  if (n % 10 === 3) return 'rd';
  return 'th';
}

/** Distance in the units a person walking would use. */
export function distanceText(metres) {
  if (!Number.isFinite(metres)) return '';
  if (metres < 10) return 'right here';
  if (metres < 1000) return `${Math.round(metres)} metres away`;
  return `${(metres / 1000).toFixed(1)} km away`;
}
