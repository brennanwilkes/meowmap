/* A small terminal UI kit: raw-mode keys, colour, boxes, and inline images.
 *
 * NO DEPENDENCY, on purpose. This repo has zero runtime deps in the Worker and zero npm
 * deps in the frontend, and the devDependencies are exactly wrangler + typescript +
 * workers-types. Pulling ink (and React, and a build step) into an admin script to draw
 * three boxes would be the largest dependency in the project by an order of magnitude.
 * Everything below is ANSI escapes, which is all a TUI library emits anyway.
 */

const ESC = '\x1b';
export const CSI = `${ESC}[`;

export const c = {
  reset: `${CSI}0m`,
  dim: `${CSI}2m`,
  bold: `${CSI}1m`,
  ital: `${CSI}3m`,
  red: `${CSI}38;5;203m`,
  green: `${CSI}38;5;114m`,
  yellow: `${CSI}38;5;221m`,
  blue: `${CSI}38;5;111m`,
  pink: `${CSI}38;5;211m`,
  grey: `${CSI}38;5;245m`,
  invert: `${CSI}7m`,
};

export const paint = (s, colour) => `${colour}${s}${c.reset}`;

/** Visible width: strip escapes first, or every box drawn around coloured text is wrong. */
export function width(s) {
  // eslint-disable-next-line no-control-regex -- stripping ANSI is the whole point
  return s.replace(/\x1b\[[0-9;]*m/g, '').length;
}

export function pad(s, n) {
  const w = width(s);
  return w >= n ? s : s + ' '.repeat(n - w);
}

export function truncate(s, n) {
  return width(s) <= n ? s : `${s.slice(0, Math.max(0, n - 1))}…`;
}

export const screen = {
  enter() {
    process.stdout.write(`${CSI}?1049h${CSI}?25l`);   // alt buffer, hide cursor
  },
  leave() {
    process.stdout.write(`${CSI}?25h${CSI}?1049l`);   // show cursor, restore buffer
  },
  clear() {
    process.stdout.write(`${CSI}2J${CSI}H`);
  },
  get cols() { return process.stdout.columns ?? 80; },
  get rows() { return process.stdout.rows ?? 24; },
};

/* ── boxes ─────────────────────────────────────────────────────────────── */

export function box(lines, { title = '', colour = c.grey, inner } = {}) {
  const w = inner ?? Math.max(...lines.map(width), width(title) + 2);
  const top = title === ''
    ? `╭${'─'.repeat(w + 2)}╮`
    : `╭─ ${title} ${'─'.repeat(Math.max(0, w - width(title) - 1))}╮`;
  const out = [paint(top, colour)];
  for (const l of lines) out.push(`${paint('│', colour)} ${pad(l, w)} ${paint('│', colour)}`);
  out.push(paint(`╰${'─'.repeat(w + 2)}╯`, colour));
  return out;
}

/* ── keys ──────────────────────────────────────────────────────────────── */

/**
 * Single keypress, no Enter. Returns a friendly name for arrows and control keys.
 *
 * Ctrl-C is handled here rather than via a SIGINT handler: in raw mode the terminal
 * does not generate the signal, so without this the only way out would be to kill the
 * process from another window — with the alternate screen buffer still active.
 */
export function onKey(handler) {
  const { stdin } = process;
  if (stdin.isTTY) stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');

  const listener = (data) => {
    if (data === '') { handler('ctrl-c'); return; }
    if (data === '[A') { handler('up'); return; }
    if (data === '[B') { handler('down'); return; }
    if (data === '[C') { handler('right'); return; }
    if (data === '[D') { handler('left'); return; }
    if (data === '\r' || data === '\n') { handler('enter'); return; }
    if (data === '') { handler('escape'); return; }
    handler(data);
  };
  stdin.on('data', listener);

  return () => {
    stdin.off('data', listener);
    if (stdin.isTTY) stdin.setRawMode(false);
    stdin.pause();
  };
}

/** One keystroke, awaited. Used for confirmations. */
export function readKey() {
  return new Promise((resolve) => {
    const off = onKey((k) => { off(); resolve(k); });
  });
}
