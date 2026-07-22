#!/usr/bin/env bash
# Git-poller CI/CD for Dream Coach. Runs on a systemd timer. Fetches the public
# repo; when main advances, gates on typecheck + tests, then redeploys in place.
# Persistent state (backend/data, backend/.env) is never touched by git because
# it is git-ignored and lives outside tracked paths.
set -euo pipefail

REPO_DIR="${DREAM_REPO_DIR:-$HOME/deployments/dream-coach-git}"
BRANCH="${DREAM_BRANCH:-main}"
SECRETS="$HOME/deployments/.secrets/dream-coach/secrets.env"
BUN="$HOME/.bun/bin/bun"
LOG_TAG="dream-poll"
HEALTH_URL="http://127.0.0.1:8130/api/admin/health"

log() { echo "[$LOG_TAG] $(date -u +%FT%TZ) $*"; }

cd "$REPO_DIR"
git fetch --quiet origin "$BRANCH"
LOCAL="$(git rev-parse HEAD)"
REMOTE="$(git rev-parse "origin/$BRANCH")"

if [ "$LOCAL" = "$REMOTE" ]; then
  exit 0  # nothing new; stay quiet
fi

log "main advanced $LOCAL -> $REMOTE; deploying"
git reset --hard "origin/$BRANCH"

# Keep the live backend env in sync with the seeded secrets on every deploy.
cp "$SECRETS" "$REPO_DIR/backend/.env"

cd "$REPO_DIR/backend"
"$BUN" install --frozen-lockfile --silent

log "gate: typecheck"
if ! "$BUN"x tsc --noEmit; then
  log "TYPECHECK FAILED at $REMOTE; not restarting (previous version stays live)"
  exit 1
fi

log "gate: tests (isolated db)"
TMPDB="$(mktemp -d)/dream.db"
if ! DB_PATH="$TMPDB" "$BUN" test >/dev/null 2>&1; then
  rm -rf "$(dirname "$TMPDB")"
  log "TESTS FAILED at $REMOTE; not restarting (previous version stays live)"
  exit 1
fi
rm -rf "$(dirname "$TMPDB")"

log "restarting dream-coach.service"
sudo systemctl restart dream-coach.service

for _ in $(seq 1 15); do
  if curl -fsS --max-time 4 "$HEALTH_URL" >/dev/null 2>&1; then
    log "healthy at $REMOTE"
    exit 0
  fi
  sleep 2
done
log "HEALTH CHECK FAILED after restart at $REMOTE — inspect: journalctl -u dream-coach.service -n 50"
exit 1
