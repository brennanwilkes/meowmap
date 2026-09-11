#!/usr/bin/env bash
# Post-deploy smoke test.
#
# Retries, deliberately. Each `wrangler secret put` creates a new Worker version, and on
# a first deploy the D1 database is seconds old, so a request fired immediately after
# can hit a rollout in progress and 500. That happened on the very first deploy
# (2026-09-11) and the app was fine thirty seconds later.
#
# A gate that goes red on a cold start is worse than no gate: it trains you to ignore
# red. So this waits for the deploy to settle, then fails hard and permanently.
set -uo pipefail

BASE="${1:?usage: _smoke.sh <base-url>}"
ATTEMPTS="${SMOKE_ATTEMPTS:-10}"
SLEEP="${SMOKE_SLEEP:-6}"

probe() {
  local path="$1" want="$2" body code
  body="$(curl -sS --max-time 15 -w '\n%{http_code}' "$BASE$path" 2>&1)" || return 1
  code="$(printf '%s' "$body" | tail -n1)"
  body="$(printf '%s' "$body" | sed '$d')"
  [ "$code" = "200" ] || { echo "  $path -> HTTP $code: ${body:0:200}"; return 1; }
  printf '%s' "$body" | grep -q "$want" || { echo "  $path -> 200 but missing $want: ${body:0:200}"; return 1; }
  echo "  $path -> 200 ok"
  return 0
}

for i in $(seq 1 "$ATTEMPTS"); do
  echo "smoke attempt $i/$ATTEMPTS"
  if probe /health '"ok":true' && probe /sightings '"sightings"' && probe /config '"turnstileSiteKey"'; then
    echo "smoke passed on attempt $i"
    exit 0
  fi
  [ "$i" -lt "$ATTEMPTS" ] && sleep "$SLEEP"
done

echo "::error::smoke test failed after $ATTEMPTS attempts over ~$((ATTEMPTS * SLEEP))s — this is a real failure, not a cold start"
exit 1
