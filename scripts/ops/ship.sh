#!/usr/bin/env bash
# ship.sh — promote main to prod, from the laptop:  bun run ship
#   1. staging must be healthy AND already running the tip of origin/main
#   2. warn when the promotion range touches migrations and staging hasn't
#      rehearsed against a fresh prod snapshot
#   3. snapshot prod, push main:release, wait for the prod poller, smoke
# Requires: P3 bootstrap done (prod checkout live), `ssh vm` configured.
set -euo pipefail
cd "$(dirname "$0")/../.."

STAGING_HEALTH="${STAGING_HEALTH:-https://staging-api.beefy-vm.com/api/admin/health}"
PROD_HEALTH="${PROD_HEALTH:-https://api.beefy-vm.com/api/admin/health}"
PROD_BASE="${PROD_HEALTH%/api/admin/health}"
SSH=(ssh -o ClearAllForwardings=yes vm)

echo "== fetch"
git fetch --quiet origin
MAIN="$(git rev-parse origin/main)"
RELEASE="$(git rev-parse origin/release 2>/dev/null || echo none)"
[[ "$MAIN" == "$RELEASE" ]] && { echo "release is already at main ($MAIN) — nothing to ship"; exit 0; }

echo "== staging gate"
staging="$(curl -fsS --max-time 10 "$STAGING_HEALTH")" || { echo "staging unreachable" >&2; exit 1; }
[[ "$staging" == *'"ok":true'* ]] || { echo "staging unhealthy: $staging" >&2; exit 1; }
[[ "$staging" == *"\"sha\":\"$MAIN\""* ]] || {
  echo "staging is not on origin/main tip ($MAIN) yet — wait for its poller or check its gate logs" >&2
  exit 1
}
echo "   staging healthy at main tip"

if [[ "$RELEASE" != "none" ]]; then
  echo "== promotion range: $(git rev-list --count "$RELEASE".."$MAIN") commits"
  git log --oneline "$RELEASE".."$MAIN" | sed 's/^/   /'
  if git diff --name-only "$RELEASE".."$MAIN" | grep -qE 'backend/(drizzle/|src/db/dataMigrations/)'; then
    echo
    echo "⚠ this range TOUCHES MIGRATIONS — rehearse first if you haven't:"
    echo "   ssh vm 'bash ~/deployments/dream/staging/scripts/ops/refresh-staging.sh --fresh'"
    read -r -p "   continue anyway? [y/N] " answer
    [[ "$answer" == "y" || "$answer" == "Y" ]] || exit 1
  fi
fi

echo "== prod snapshot"
"${SSH[@]}" 'bash ~/deployments/dream/prod/scripts/ops/snapshot.sh prod' | tail -1

echo "== push main -> release"
git push origin "$MAIN":refs/heads/release

echo "== waiting for the prod poller (runs every 3 min)"
for i in $(seq 1 60); do
  body="$(curl -fsS --max-time 5 "$PROD_HEALTH" 2>/dev/null || true)"
  if [[ "$body" == *"\"sha\":\"$MAIN\""* ]]; then
    bash scripts/ops/smoke.sh "$PROD_BASE" prod
    echo "SHIPPED: prod is at ${MAIN:0:8}"
    exit 0
  fi
  sleep 10
done
echo "prod did not reach $MAIN in 10 minutes — inspect: ssh vm 'tail -50 ~/deployments/dream/poll-prod.log'" >&2
exit 1
