import { execFileSync, spawnSync } from 'node:child_process';

/* Show a photo in the terminal, if this terminal can do it at all.
 *
 * Three tiers, best first, and NO decoding of our own. Two of these hand the terminal
 * the raw JPEG bytes and let it draw them, which is why there is no image library here.
 *
 *   1. kitty / Ghostty / WezTerm — the kitty graphics protocol, real pixels.
 *   2. iTerm2 — its inline-image escape, also real pixels.
 *   3. chafa or viu on PATH — colour-block approximation, works in any terminal.
 *
 * Anything else gets no preview and says so once. A preview is a convenience; `o` opens
 * the real image in a browser and is always available.
 */

function have(bin) {
  return spawnSync('sh', ['-c', `command -v ${bin}`], { encoding: 'utf8' }).status === 0;
}

let cachedMode = null;

export function previewMode() {
  if (cachedMode !== null) return cachedMode;
  const term = process.env.TERM ?? '';
  const prog = process.env.TERM_PROGRAM ?? '';

  if (process.env.KITTY_WINDOW_ID !== undefined || term.includes('kitty')
      || prog === 'ghostty' || prog === 'WezTerm') {
    cachedMode = 'kitty';
  } else if (prog === 'iTerm.app') {
    cachedMode = 'iterm';
  } else if (have('chafa')) {
    cachedMode = 'chafa';
  } else if (have('viu')) {
    cachedMode = 'viu';
  } else {
    cachedMode = 'none';
  }
  return cachedMode;
}

export const PREVIEW_HELP = 'install `chafa` for inline photo previews (sudo apt install chafa)';

/**
 * Render `bytes` at roughly `cols` x `rows` character cells.
 *
 * Returns true if something was drawn. The caller positions the cursor first; these
 * protocols draw at the cursor and do not move it predictably, so the caller must not
 * assume anything about where the cursor ends up.
 */
export function drawImage(bytes, cols, rows) {
  const mode = previewMode();
  if (mode === 'none') return false;

  if (mode === 'kitty') {
    // a=T transmit-and-display, f=100 means "these are PNG/JPEG file bytes, you decode
    // them", c/r size it in cells. Chunked at 4096 because the protocol requires it.
    const b64 = Buffer.from(bytes).toString('base64');
    const CHUNK = 4096;
    for (let i = 0; i < b64.length; i += CHUNK) {
      const piece = b64.slice(i, i + CHUNK);
      const more = i + CHUNK < b64.length ? 1 : 0;
      const opts = i === 0 ? `a=T,f=100,c=${cols},r=${rows},m=${more}` : `m=${more}`;
      process.stdout.write(`\x1b_G${opts};${piece}\x1b\\`);
    }
    return true;
  }

  if (mode === 'iterm') {
    const b64 = Buffer.from(bytes).toString('base64');
    process.stdout.write(
      `\x1b]1337;File=inline=1;width=${cols};height=${rows};preserveAspectRatio=1:${b64}\x07`,
    );
    return true;
  }

  try {
    const args = mode === 'chafa'
      ? ['--size', `${cols}x${rows}`, '--clear', '-']
      : ['-w', String(cols), '-h', String(rows), '-'];
    const out = execFileSync(mode, args, { input: Buffer.from(bytes), encoding: 'buffer' });
    process.stdout.write(out);
    return true;
  } catch {
    // A preview failing must never take the browser down with it.
    return false;
  }
}
