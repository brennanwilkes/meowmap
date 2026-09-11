import type { Env } from './types.ts';
import { JSON_CT, NO_STORE } from './constants.ts';
import { corsHeaders } from './cors.ts';

/** The ONLY places a Response is constructed. Keeping that true is what guarantees every
 *  reply carries CORS and a deliberate Cache-Control, rather than whichever the handler
 *  happened to remember. */

export function json(
  req: Request,
  env: Env,
  status: number,
  body: unknown,
  extra: Record<string, string> = {},
): Response {
  const headers = new Headers(corsHeaders(req, env));
  headers.set('Content-Type', JSON_CT);
  if (!('Cache-Control' in extra)) headers.set('Cache-Control', NO_STORE);
  for (const [k, v] of Object.entries(extra)) headers.set(k, v);
  return new Response(JSON.stringify(body), { status, headers });
}

export function errorJson(req: Request, env: Env, status: number, message: string): Response {
  return json(req, env, status, { error: message });
}

export function noContent(req: Request, env: Env): Response {
  return new Response(null, { status: 204, headers: new Headers(corsHeaders(req, env)) });
}

export function notModified(req: Request, env: Env, etag: string, cacheControl: string): Response {
  const headers = new Headers(corsHeaders(req, env));
  headers.set('ETag', etag);
  headers.set('Cache-Control', cacheControl);
  return new Response(null, { status: 304, headers });
}
