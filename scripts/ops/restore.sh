#!/usr/bin/env bash
# restore.sh <env> <snapshot.db> [--yes-prod] — stop the env, swap its DB for
# the snapshot, start, health-check. The displaced DB is kept beside the live
# one as dream.db.pre-restore-<ts>. Refuses prod without --yes-prod.
set -euo pipefail
source "$(dirname "$0")/common.sh"
load_env_conf "${1:?usage: restore.sh <env> <snapshot> [--yes-prod]}"
snap="${2:?usage: restore.sh <env> <snapshot> [--yes-prod]}"
[[ -f "$snap" ]] || die "no snapshot at $snap"
if [[ "$DREAM_ENV" == "prod" && "${3:-}" != "--yes-prod" ]]; then
  die "refusing to overwrite the PROD database; pass --yes-prod if you really mean it"
fi

pm2 stop "$PM2_APP" >/dev/null 2>&1 || true
mkdir -p "$(dirname "$DB")"
if [[ -f "$DB" ]]; then
  mv "$DB" "$DB.pre-restore-$(date -u +%Y%m%dT%H%M%SZ)"
fi
rm -f "$DB-wal" "$DB-shm"
cp "$snap" "$DB"
pm2_restart_or_start >/dev/null
wait_healthy
log "restored $DREAM_ENV from $(basename "$snap")"
