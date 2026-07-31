#!/usr/bin/env bash
# bootstrap-vm.sh <staging|preview|prod|all> [--caddy] — idempotent VM setup
# for one environment: checkout, conf, env overrides (+ generated admin MCP
# token), first deploy via poll.sh --force, pm2 save, cron entries. With
# --caddy it also appends the env's vhosts to /etc/caddy/Caddyfile (sudo) and
# reloads. Run ON the VM. Safe to re-run; existing conf/overrides are kept.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
source "$here/common.sh"

REPO_URL="${DREAM_REPO_URL:-https://github.com/darenhua/dream.git}"
DOMAIN_BASE="${DREAM_DOMAIN_BASE:-beefy-vm.com}"
targets=()
caddy_apply=""
for arg in "$@"; do
  case "$arg" in
    --caddy) caddy_apply=1 ;;
    all) targets=(staging preview prod) ;;
    staging|preview|prod) targets+=("$arg") ;;
    *) die "unknown argument: $arg" ;;
  esac
done
[[ ${#targets[@]} -gt 0 ]] || die "usage: bootstrap-vm.sh <staging|preview|prod|all> [--caddy]"

env_branch() { case "$1" in prod) echo release ;; *) echo main ;; esac; }
env_port()   { case "$1" in prod) echo 8140 ;; staging) echo 8141 ;; preview) echo 8142 ;; esac; }
env_api_host() {
  case "$1" in
    prod) echo "api.$DOMAIN_BASE" ;;
    staging) echo "staging-api.$DOMAIN_BASE" ;;
    preview) echo "preview-api.$DOMAIN_BASE" ;;
  esac
}
env_mcp_host() {
  case "$1" in
    prod) echo "mcp.$DOMAIN_BASE" ;;
    staging) echo "staging-mcp.$DOMAIN_BASE" ;;
    preview) echo "preview-api.$DOMAIN_BASE" ;;
  esac
}

bootstrap_one() {
  local name="$1" port branch dir
  port="$(env_port "$name")"
  branch="$(env_branch "$name")"
  dir="$DREAM_BASE/$name"
  mkdir -p "$DREAM_BASE" "$SNAPDIR"

  if [[ ! -d "$dir/.git" ]]; then
    log "$name: cloning $REPO_URL ($branch)"
    if ! git clone --quiet --branch "$branch" "$REPO_URL" "$dir" 2>/dev/null; then
      [[ "$name" == "prod" ]] && die "branch '$branch' does not exist yet — create it: git push origin main:release"
      die "clone failed for $name"
    fi
  fi

  if [[ ! -f "$DREAM_BASE/$name.conf" ]]; then
    cat > "$DREAM_BASE/$name.conf" <<CONF
DREAM_ENV=$name
BRANCH=$branch
DIR=$dir
PORT=$port
PM2_APP=dream-$name
CONF
    log "$name: wrote $name.conf"
  fi

  if [[ ! -f "$DREAM_BASE/$name.env.overrides" ]]; then
    local token token_file sha
    token="$(openssl rand -hex 32)"
    token_file="$(dirname "$DREAM_SECRETS")/admin-token-$name.txt"
    printf '%s\n' "$token" > "$token_file" && chmod 600 "$token_file"
    sha="$(printf '%s' "$token" | sha256sum | cut -d' ' -f1)"
    cat > "$DREAM_BASE/$name.env.overrides" <<OVR
APP_ENV=$name
PORT=$port
BIND_HOST=127.0.0.1
PUBLIC_URL=https://$(env_api_host "$name")
MCP_PUBLIC_URL=https://$(env_mcp_host "$name")
MCP_ALLOWED_HOSTS=$(env_mcp_host "$name"),$(env_api_host "$name"),127.0.0.1:$port,127.0.0.1
MCP_TRUST_PROXY=true
ADMIN_MCP_TOKEN_SHA256=$sha
OVR
    log "$name: wrote $name.env.overrides (admin token plaintext: $token_file)"
  fi

  log "$name: first deploy"
  bash "$dir/scripts/ops/poll.sh" "$name" --force

  if [[ "$name" != "preview" ]]; then
    install_cron "*/3 * * * * bash $dir/scripts/ops/poll.sh $name >> $DREAM_BASE/poll-$name.log 2>&1"
  fi
  if [[ "$name" == "staging" ]]; then
    install_cron "5 9 * * * cd $dir/backend && $BUN run heartbeat >> $DREAM_BASE/heartbeat-staging.log 2>&1"
  fi
  if [[ "$name" == "prod" ]]; then
    install_cron "0 9 * * * cd $dir/backend && $BUN run heartbeat >> $DREAM_BASE/heartbeat-prod.log 2>&1"
    install_cron "30 3 * * * bash $dir/scripts/ops/snapshot.sh prod --prune >> $SNAPDIR/cron.log 2>&1"
  fi
}

install_cron() {
  local line="$1"
  if ! crontab -l 2>/dev/null | grep -Fq "$line"; then
    (crontab -l 2>/dev/null; echo "$line") | crontab -
    log "cron installed: $line"
  fi
}

emit_caddy() {
  local name="$1" port dir
  port="$(env_port "$name")"
  dir="$DREAM_BASE/$name"
  cat <<CADDY

# dream-$name (managed by bootstrap-vm.sh)
$(env_api_host "$name") {
	reverse_proxy 127.0.0.1:$port
}
CADDY
  if [[ "$name" != "preview" ]]; then
    cat <<CADDY
$(env_mcp_host "$name") {
	reverse_proxy 127.0.0.1:$port
}
CADDY
  fi
  local dash_host
  case "$name" in
    prod) dash_host="dashboard.$DOMAIN_BASE" ;;
    staging) dash_host="staging-dash.$DOMAIN_BASE" ;;
    preview) return 0 ;;
  esac
  cat <<CADDY
$dash_host {
	handle /api/* {
		reverse_proxy 127.0.0.1:$port
	}
	handle {
		root * $dir/dashboard/dist
		try_files {path} /index.html
		file_server
	}
}
CADDY
}

for name in "${targets[@]}"; do
  bootstrap_one "$name"
done
pm2 save >/dev/null && log "pm2 save done"

for name in "${targets[@]}"; do
  marker="# dream-$name (managed by bootstrap-vm.sh)"
  if [[ -n "$caddy_apply" ]]; then
    if sudo grep -Fq "$marker" /etc/caddy/Caddyfile; then
      log "$name: Caddy vhosts already present"
    else
      emit_caddy "$name" | sudo tee -a /etc/caddy/Caddyfile >/dev/null
      log "$name: Caddy vhosts appended"
    fi
  else
    echo "----- add to /etc/caddy/Caddyfile for $name (or re-run with --caddy) -----"
    emit_caddy "$name"
  fi
done
if [[ -n "$caddy_apply" ]]; then
  sudo systemctl reload caddy && log "caddy reloaded"
fi

cat <<'NOTE'

Reboot-safety reminder (one-time, needs sudo):
  pm2 startup   # then run the command it prints
  pm2 save
NOTE
