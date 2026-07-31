#!/usr/bin/env bash
# preview.sh <ref> [--seed|--from-prod] — deploy any branch, sha, or "pr/N"
# to the single preview slot. Default keeps the slot's current DB; --seed
# nukes and seeds fixtures; --from-prod restores the newest prod snapshot
# (safe: preview's kill-switch blocks all real side effects).
set -euo pipefail
here="$(dirname "$0")"
source "$here/common.sh"
load_env_conf preview
ref="${1:?usage: preview.sh <branch|sha|pr/N> [--seed|--from-prod]}"
mode="${2:-}"

cd "$DIR"
if [[ "$ref" =~ ^pr/([0-9]+)$ ]]; then
  git fetch --quiet origin "pull/${BASH_REMATCH[1]}/head"
else
  git fetch --quiet origin "$ref" || git fetch --quiet origin
fi
git checkout --quiet --detach FETCH_HEAD 2>/dev/null || git checkout --quiet --detach "$ref"
sha="$(git rev-parse HEAD)"
compose_backend_env "$sha"

cd "$DIR/backend"
"$BUN" install --frozen-lockfile --silent
cd "$DIR/dashboard"
"$BUN" install --silent
"$BUN" run build >/dev/null

pm2_restart_or_start >/dev/null
wait_healthy "$sha"

case "$mode" in
  --seed)
    bash "$here/nuke.sh" preview
    (cd "$DIR/backend" && "$BUN" run seed)
    ;;
  --from-prod)
    snap="$(ls -t "$SNAPDIR"/dream-prod-*.db 2>/dev/null | head -1)"
    [[ -n "$snap" ]] || die "no prod snapshots to restore"
    bash "$here/restore.sh" preview "$snap"
    ;;
esac
bash "$here/smoke.sh" "http://127.0.0.1:$PORT" preview
log "preview serving $ref ($sha)"
