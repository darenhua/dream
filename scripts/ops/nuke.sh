#!/usr/bin/env bash
# nuke.sh <env> — wipe an environment's DB to empty-but-migrated via the
# admin reset endpoint (schema survives, content does not). Refuses prod
# unless FORCE=1 is set in the environment.
set -euo pipefail
source "$(dirname "$0")/common.sh"
load_env_conf "${1:?usage: nuke.sh <env>}"
if [[ "$DREAM_ENV" == "prod" && "${FORCE:-}" != "1" ]]; then
  die "refusing to nuke PROD; set FORCE=1 if you really mean it"
fi
curl -fsS --max-time 15 -X POST "http://127.0.0.1:$PORT/api/admin/reset" \
  -H 'content-type: application/json' -d '{"confirm":"RESET"}' >/dev/null
log "nuked $DREAM_ENV (schema kept, content gone)"
