import type { Env } from './types.ts';
import { MAX_UA_LEN } from './constants.ts';

/* One row per MUTATING request, written only AFTER the rate limiter and the upload pass
 * have both passed. That ordering is load-bearing: auditing pre-auth traffic would let
 * one attacker spend the whole 100k/day D1 write budget and take the app offline until
 * midnight UTC.
 *
 * Reads are deliberately not audited — see the note in 001_initial.sql.
 *
 * This is the "which of the two phones did this" trail. The single most useful field is
 * as_org: "Rogers Communications" vs "DigitalOcean" separates her phone from a scraper at
 * a glance, far better than the IP itself. */

export interface AuditFields {
  method: string;
  path: string;          // the matched route PATTERN, not the raw path, so it groups
  status: number;
  outcome: string;
  deviceId?: string | null;
  passSub?: string | null;
  passIat?: number | null;
  targetId?: number | null;
  bytesIn?: number | null;
  detail?: string | null;
}

export function auditStatement(
  env: Env, req: Request, now: number, f: AuditFields,
): D1PreparedStatement {
  // request.cf is undefined under `wrangler dev` without --remote. Guard explicitly and
  // store nulls rather than inventing values.
  const cf = req.cf as IncomingRequestCfProperties | undefined;
  const ua = req.headers.get('User-Agent');

  return env.MEOWMAP_DB
    .prepare(
      `INSERT INTO audit_log
         (ts, method, path, status, outcome, device_id, pass_sub, pass_iat,
          ip, country, colo, asn, as_org, ray_id, http_proto, tls_version,
          user_agent, ua_platform, target_id, bytes_in, detail)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21)`,
    )
    .bind(
      now, f.method, f.path, f.status, f.outcome,
      f.deviceId ?? null, f.passSub ?? null, f.passIat ?? null,
      req.headers.get('CF-Connecting-IP'),
      cf?.country ?? null,
      cf?.colo ?? null,
      // asn and asOrganization are OPTIONAL in the type. Store null, never ?? 0 — a
      // fabricated ASN 0 in an audit trail is worse than an honest gap.
      cf?.asn ?? null,
      cf?.asOrganization ?? null,
      req.headers.get('CF-Ray'),
      cf?.httpProtocol ?? null,
      cf?.tlsVersion ?? null,
      ua === null ? null : ua.slice(0, MAX_UA_LEN),
      req.headers.get('Sec-CH-UA-Platform'),   // Chromium-only; null on Safari
      f.targetId ?? null,
      f.bytesIn ?? null,
      f.detail ?? null,
    );
}
