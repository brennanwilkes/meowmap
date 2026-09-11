import type { Env } from './types.ts';
import { HttpError } from './types.ts';
import { TURNSTILE_ACTION, TURNSTILE_HOSTNAMES, TURNSTILE_VERIFY_URL } from './constants.ts';

/* Turnstile is genuinely free: unlimited challenges and unlimited siteverify calls, up to
 * 20 widgets per account and 10 hostnames per widget. No metering to design around.
 *
 * Being cross-origin does not matter here. The widget runs entirely inside the page on
 * GitHub Pages and never talks to this Worker; siteverify is a server-to-server call, so
 * no browser and no CORS are involved. The one requirement is that the widget's hostname
 * list contains the exact Pages host. */

interface SiteVerifyResponse {
  success: boolean;
  hostname?: string;
  action?: string;
  challenge_ts?: string;
  'error-codes'?: string[];
}

/**
 * Verify a Turnstile token. Throws on every failure path — this must NEVER fail open,
 * so there is deliberately no branch that issues a pass without success === true.
 */
export async function verifyTurnstile(env: Env, token: string, ip: string | null): Promise<void> {
  let res: Response;
  try {
    res = await fetch(TURNSTILE_VERIFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        secret: env.TURNSTILE_SECRET_KEY,
        response: token,
        remoteip: ip,
        // Makes a network-level retry safe rather than burning the single-use token.
        idempotency_key: crypto.randomUUID(),
      }),
    });
  } catch {
    throw new HttpError(503, 'Verification unavailable', 'error');
  }

  if (!res.ok) throw new HttpError(503, 'Verification unavailable', 'error');

  const data = (await res.json()) as SiteVerifyResponse;

  if (data.success !== true) {
    const codes = data['error-codes'] ?? [];
    // A bad secret is a deployment fault, not a user fault. It must be loud and it must
    // not be reported as "your challenge failed" — this is the alarm for "the secret
    // never got pushed by CI".
    if (codes.includes('invalid-input-secret') || codes.includes('missing-input-secret')) {
      console.error('[turnstile] secret rejected:', codes.join(','));
      throw new HttpError(500, 'Server misconfigured', 'error');
    }
    if (codes.includes('timeout-or-duplicate')) {
      throw new HttpError(400, 'Challenge expired — please try again', 'pass_denied');
    }
    if (codes.includes('internal-error')) {
      throw new HttpError(503, 'Verification unavailable', 'error');
    }
    throw new HttpError(400, 'Challenge invalid — please try again', 'pass_denied');
  }

  // Defence in depth beyond success: a leaked sitekey used from another page would still
  // verify, so pin the hostname and the action.
  const allowed = [...TURNSTILE_HOSTNAMES, ...hostsFromOrigin(env.ALLOWED_ORIGIN)];
  if (data.hostname !== undefined && allowed.length > 0 && !allowed.includes(data.hostname)) {
    console.error('[turnstile] unexpected hostname:', data.hostname);
    throw new HttpError(403, 'Forbidden', 'pass_denied');
  }
  if (data.action !== undefined && data.action !== TURNSTILE_ACTION) {
    throw new HttpError(403, 'Forbidden', 'pass_denied');
  }
}

function hostsFromOrigin(origin: string): string[] {
  if (origin === '*') return [];
  try {
    return [new URL(origin).hostname];
  } catch {
    return [];
  }
}
