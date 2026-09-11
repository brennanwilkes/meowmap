import type { Env } from './types.ts';

/** The frontend is cross-origin (GitHub Pages) from this Worker, so every route needs
 *  these — including the photo route, or service-worker caching gets opaque responses
 *  whose quota accounting is padded and whose status is unreadable. */
export function corsHeaders(req: Request, env: Env): HeadersInit {
  const origin = req.headers.get('Origin');
  if (env.ALLOWED_ORIGIN !== '*' && origin !== env.ALLOWED_ORIGIN) return {};
  const allow = env.ALLOWED_ORIGIN === '*' ? '*' : (origin as string);

  const headers: Record<string, string> = {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization,If-None-Match',
    // Easy to miss and silently breaks two features: without ETag the client cannot do
    // conditional bulk fetches, and without X-Pass-Renewed the sliding pass renewal never
    // reaches localStorage, so both phones get challenged every 30 days after all.
    'Access-Control-Expose-Headers': 'ETag,X-Pass-Renewed',
    'Access-Control-Max-Age': '86400',
  };
  // Only vary when the value actually depends on the request. With "*" it does not, and
  // a needless Vary fragments the Workers Cache per origin.
  if (env.ALLOWED_ORIGIN !== '*') headers['Vary'] = 'Origin';
  return headers;
}

export function handleOptions(req: Request, env: Env): Response {
  return new Response(null, { status: 204, headers: corsHeaders(req, env) });
}
