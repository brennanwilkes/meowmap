/* The one place a failure becomes visible.
 *
 * NOTHING IN THIS APP MAY FAIL SILENTLY. The save button spent a day appearing to do
 * nothing at all: its only feedback was a line of text inside the scrolling form, and
 * anything that threw landed in an unhandled rejection with the button left disabled.
 * A photo she took is the one thing this app cannot lose track of, so every path that
 * can fail says so here — on top of whatever screen she is on, in her words where we
 * have them and the raw message where we do not.
 *
 * Deliberately NOT a logger. It is a bar she can read and dismiss; there is no ring
 * buffer, no upload, and no D1 row. A message she can read aloud over the phone is the
 * whole debugging story this app needs.
 */

const VISIBLE_MS = 9000;

let timer = null;

export function showError(message) {
  const app = document.getElementById('app');
  let bar = document.getElementById('err-bar');
  if (bar === null) {
    bar = document.createElement('button');
    bar.id = 'err-bar';
    bar.className = 'err-bar';
    bar.type = 'button';
    bar.addEventListener('click', dismiss);
    app.appendChild(bar);
  }
  // Last one wins rather than stacking: a failure usually arrives with its own echoes
  // (the throw, then the rejection), and three bars on top of each other say less.
  bar.textContent = String(message ?? '').trim() === ''
    ? 'Something went wrong. Please try again.'
    : String(message);
  if (timer !== null) clearTimeout(timer);
  timer = setTimeout(dismiss, VISIBLE_MS);
}

export function dismiss() {
  if (timer !== null) { clearTimeout(timer); timer = null; }
  const bar = document.getElementById('err-bar');
  if (bar !== null) bar.remove();
}
