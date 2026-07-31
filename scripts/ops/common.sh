# Shared loader for the Dream ops library. Source, then: load_env_conf <env>.
# Layout on the VM (created by bootstrap-vm.sh):
#   ~/deployments/dream/<env>.conf           DREAM_ENV BRANCH DIR PORT PM2_APP
#   ~/deployments/dream/<env>.env.overrides  env-specific backend .env tail
#   ~/deployments/dream/<env>/               git checkout (backend/ dashboard/)
#   ~/deployments/dream/snapshots/           dream-<env>-<ts>.db
DREAM_BASE="${DREAM_BASE:-$HOME/deployments/dream}"
DREAM_SECRETS="${DREAM_SECRETS:-$HOME/deployments/.secrets/dream-coach/secrets.env}"
BUN="${BUN:-$HOME/.bun/bin/bun}"
SNAPDIR="$DREAM_BASE/snapshots"

log() { echo "[$(date -u +%FT%TZ)] $*"; }
die() { echo "error: $*" >&2; exit 1; }

load_env_conf() {
  local name="${1:?usage: load_env_conf prod|staging|preview}"
  CONF="$DREAM_BASE/$name.conf"
  [[ -f "$CONF" ]] || die "missing $CONF — run bootstrap-vm.sh $name first"
  # shellcheck source=/dev/null
  source "$CONF"
  OVERRIDES="$DREAM_BASE/$name.env.overrides"
  DB="$DIR/backend/data/dream.db"
}

# Compose backend/.env: shared secrets, then env-specific overrides (later
# keys win in Bun's .env loading), then the deployed sha.
compose_backend_env() {
  local sha="${1:-}"
  { cat "$DREAM_SECRETS"; echo; cat "$OVERRIDES"; echo; [[ -n "$sha" ]] && echo "GIT_SHA=$sha"; } \
    > "$DIR/backend/.env"
}

health_json() { curl -fsS --max-time 5 "http://127.0.0.1:$PORT/api/admin/health"; }

wait_healthy() {
  local expect_sha="${1:-}" i body
  for i in $(seq 1 20); do
    if body="$(health_json 2>/dev/null)"; then
      if [[ -z "$expect_sha" || "$body" == *"\"sha\":\"$expect_sha\""* ]]; then
        [[ "$body" == *"\"env\":\"$DREAM_ENV\""* ]] || die "health answered for wrong env: $body"
        log "healthy: $DREAM_ENV${expect_sha:+ at $expect_sha}"
        return 0
      fi
    fi
    sleep 3
  done
  die "$DREAM_ENV not healthy${expect_sha:+ at $expect_sha} — pm2 logs $PM2_APP"
}

pm2_restart_or_start() {
  if pm2 describe "$PM2_APP" >/dev/null 2>&1; then
    pm2 restart "$PM2_APP" --update-env
  else
    pm2 start "$BUN" --name "$PM2_APP" --cwd "$DIR/backend" -- run serve
  fi
}
