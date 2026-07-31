#!/usr/bin/env bash
# poll.sh <env> [--force] — the CD poller. Cron runs this every ~3 minutes per
# environment; when the env's branch advances (staging←main, prod←release) it
# gates on typecheck+tests, builds the dashboard, snapshots prod, restarts the
# pm2 app, and health-checks the new sha. A failed gate leaves the previous
# version live. --force redeploys the current tip even with no new commits
# (used by bootstrap and for rebuilds).
set -euo pipefail

# git reset --hard rewrites this very file mid-run; execute from a copy.
if [[ -z "${DREAM_POLL_COPIED:-}" ]]; then
  tmp="$(mktemp)"
  cp "$0" "$tmp"
  DREAM_POLL_COPIED=1 exec bash "$tmp" "$@"
fi

ENV_NAME="${1:?usage: poll.sh <env> [--force]}"
FORCE="${2:-}"
# common.sh from the checkout (stable across the reset because we source the
# post-reset copy after cd; conf locations don't move).
DREAM_BASE="${DREAM_BASE:-$HOME/deployments/dream}"
source "$DREAM_BASE/$ENV_NAME.conf" 2>/dev/null || { echo "missing $DREAM_BASE/$ENV_NAME.conf" >&2; exit 1; }
source "$DIR/scripts/ops/common.sh"
load_env_conf "$ENV_NAME"

cd "$DIR"
git fetch --quiet origin "$BRANCH"
LOCAL="$(git rev-parse HEAD)"
REMOTE="$(git rev-parse "origin/$BRANCH")"
if [[ "$LOCAL" == "$REMOTE" && "$FORCE" != "--force" ]]; then
  exit 0
fi

log "$DREAM_ENV: $BRANCH advanced ${LOCAL:0:8} -> ${REMOTE:0:8}; deploying"
git reset --hard "$REMOTE" >/dev/null
compose_backend_env "$REMOTE"

cd "$DIR/backend"
"$BUN" install --frozen-lockfile --silent

log "gate: typecheck"
if ! "$BUN"x tsc --noEmit -p .; then
  log "TYPECHECK FAILED at $REMOTE — previous version stays live"
  exit 1
fi
log "gate: tests (scratch db)"
tmpdb="$(mktemp -d)"
if ! DB_PATH="$tmpdb/dream.db" APP_ENV=dev "$BUN" test >/dev/null 2>&1; then
  rm -rf "$tmpdb"
  log "TESTS FAILED at $REMOTE — previous version stays live"
  exit 1
fi
rm -rf "$tmpdb"

log "dashboard build"
cd "$DIR/dashboard"
"$BUN" install --silent
"$BUN" run build >/dev/null

if [[ "$DREAM_ENV" == "prod" ]]; then
  log "pre-deploy prod snapshot"
  bash "$DIR/scripts/ops/snapshot.sh" prod >/dev/null
fi

log "restart $PM2_APP"
pm2_restart_or_start >/dev/null
wait_healthy "$REMOTE"
bash "$DIR/scripts/ops/smoke.sh" "http://127.0.0.1:$PORT" "$DREAM_ENV"
log "$DREAM_ENV deployed at $REMOTE"
