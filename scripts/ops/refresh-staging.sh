#!/usr/bin/env bash
# refresh-staging.sh [--fresh] — restore staging's DB from the newest prod
# snapshot (or take one right now with --fresh), so the next boot rehearses
# migrations against prod-shaped data. Staging's APP_ENV kill-switch makes
# this safe: transport mock, strikes off, calendar disconnected.
set -euo pipefail
here="$(dirname "$0")"
source "$here/common.sh"

if [[ "${1:-}" == "--fresh" ]]; then
  snap="$(bash "$here/snapshot.sh" prod | tail -1)"
else
  snap="$(ls -t "$SNAPDIR"/dream-prod-*.db 2>/dev/null | head -1)"
  [[ -n "$snap" ]] || die "no prod snapshots in $SNAPDIR (run snapshot.sh prod, or --fresh)"
fi
log "refreshing staging from $(basename "$snap")"
bash "$here/restore.sh" staging "$snap"
