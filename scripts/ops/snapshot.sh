#!/usr/bin/env bash
# snapshot.sh <env> [--prune] — WAL-safe snapshot of an environment's DB into
# ~/deployments/dream/snapshots/dream-<env>-<ts>.db. --prune drops snapshots
# for that env older than 14 days (used by the daily cron).
set -euo pipefail
source "$(dirname "$0")/common.sh"
load_env_conf "${1:?usage: snapshot.sh <env> [--prune]}"

mkdir -p "$SNAPDIR"
[[ -f "$DB" ]] || die "no database at $DB"
dest="$SNAPDIR/dream-$DREAM_ENV-$(date -u +%Y%m%dT%H%M%SZ).db"
sqlite3 "$DB" "VACUUM INTO '$dest'"
log "snapshot: $dest ($(du -h "$dest" | cut -f1))"
if [[ "${2:-}" == "--prune" ]]; then
  find "$SNAPDIR" -name "dream-$DREAM_ENV-*.db" -mtime +14 -delete
fi
echo "$dest"
