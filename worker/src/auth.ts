import type { Env } from './types.ts';
import { HttpError } from './types.ts';
import { PASS_TYP } from './constants.ts';
import { signJwt, verifyJwt, type JwtPayload } from './jwt.ts';

/* The "upload pass": one Turnstile solve exchanged for a 30-day HS256 token.
 *
 * `sub` is the device UUID from localStorage. Treat it as a LABEL, never an identity —
 * an attacker rotates it freely, which is why RL_MUTATE_IP is the real bound and
 * RL_MUTATE_DEVICE is only a courtesy limiter for honest clients.
 *
 * There is deliberately no revocation table: it would cost a D1 read on the hot path
 * forever to solve a problem this app will not have. The panic button is rotating
 * PASS_SIGNING_SECRET and re-running CI, which kills every pass at once. */

export function bearerToken(req: Request): string | null {
  const h = req.headers.get('Authorization') ?? '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m === null ? null : m[1];
}

const DAY_S = 86_400;

export async function issuePass(env: Env, deviceId: string, now: number): Promise<string> {
  const iat = Math.floor(now / 1000);
  return await signJwt(
    {
      sub: deviceId,
      iss: env.JWT_ISS,
      aud: env.JWT_AUD,
      iat,
      exp: iat + Number(env.PASS_TTL_DAYS) * DAY_S,
      typ: PASS_TYP,
    },
    env.PASS_SIGNING_SECRET,
  );
}

/** Throws 401 for anything wrong. verifyJwt already checks alg, signature, exp, iss, aud
 *  and a non-empty sub; it knows nothing about token kinds, so `typ` is checked here. */
export async function requirePass(env: Env, req: Request, now: number): Promise<JwtPayload> {
  const token = bearerToken(req);
  if (token === null) throw new HttpError(401, 'Missing upload pass', 'invalid');

  let payload: JwtPayload;
  try {
    payload = await verifyJwt(token, env.PASS_SIGNING_SECRET, {
      iss: env.JWT_ISS,
      aud: env.JWT_AUD,
      now: Math.floor(now / 1000),
    });
  } catch (err) {
    throw new HttpError(401, err instanceof Error ? err.message : 'Invalid token', 'invalid');
  }
  if (payload.typ !== PASS_TYP) throw new HttpError(401, 'Invalid token', 'invalid');
  return payload;
}

/**
 * Sliding renewal. Without it each phone is challenged 12 times a year, and always at the
 * worst moment — mid-upload, in a parking lot, on bad LTE. With it, any phone used more
 * than once every (30 - 7) days is challenged exactly once, ever.
 *
 * Returns a fresh pass when the current one is near expiry, else null. The caller puts it
 * in X-Pass-Renewed, which is why that header MUST be in Access-Control-Expose-Headers.
 */
export async function maybeRenew(env: Env, payload: JwtPayload, now: number): Promise<string | null> {
  const secondsLeft = payload.exp - Math.floor(now / 1000);
  if (secondsLeft > Number(env.PASS_RENEW_WITHIN_DAYS) * DAY_S) return null;
  return await issuePass(env, payload.sub, now);
}
