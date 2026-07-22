#!/usr/bin/env bash
# One-time (idempotent) bootstrap of the Dream Coach git-poller deployment on
# the VM. Safe to re-run. Run as the deploy user (not root); uses sudo for
# systemd/caddy files only.
#
#   curl -fsSL https://raw.githubusercontent.com/darenhua/dream/main/deploy/vm-bootstrap.sh | bash
set -euo pipefail

REPO_URL="https://github.com/darenhua/dream.git"
REPO_DIR="$HOME/deployments/dream-coach-git"
SECRETS_DIR="$HOME/deployments/.secrets/dream-coach"
SECRETS="$SECRETS_DIR/secrets.env"
TOKEN_FILE="$SECRETS_DIR/companion-token.txt"
MCP_HOST="100-48-129-170.nip.io"
BUN="$HOME/.bun/bin/bun"

echo "== 1/6 clone or update checkout"
if [ ! -d "$REPO_DIR/.git" ]; then
  git clone --branch main "$REPO_URL" "$REPO_DIR"
else
  git -C "$REPO_DIR" fetch origin main && git -C "$REPO_DIR" reset --hard origin/main
fi

echo "== 2/6 secrets: MCP-public + companion token (idempotent appends)"
[ -f "$SECRETS" ] || { echo "missing $SECRETS — seed it first (see deployment.md)"; exit 1; }
ensure() { grep -q "^$1=" "$SECRETS" || echo "$1=$2" >> "$SECRETS"; }
ensure BIND_HOST 127.0.0.1
ensure MCP_PUBLIC_URL "https://$MCP_HOST"
ensure MCP_ALLOWED_HOSTS "$MCP_HOST"
ensure MCP_TRUST_PROXY true
if ! grep -q "^COMPANION_AUTH_TOKEN_SHA256=" "$SECRETS"; then
  TOKEN="$(head -c 32 /dev/urandom | xxd -p -c 64)"
  HASH="$(printf %s "$TOKEN" | sha256sum | cut -d' ' -f1)"
  ( umask 077; printf %s "$TOKEN" > "$TOKEN_FILE" )
  echo "COMPANION_AUTH_TOKEN_SHA256=$HASH" >> "$SECRETS"
  echo "   companion token written to $TOKEN_FILE (chmod 600) — configure your MCP client with it"
fi
cp "$SECRETS" "$REPO_DIR/backend/.env"

echo "== 3/6 backend deps + gate"
( cd "$REPO_DIR/backend" && "$BUN" install --frozen-lockfile --silent && "$BUN"x tsc --noEmit )

echo "== 4/6 systemd units"
chmod +x "$REPO_DIR/deploy/dream-coach-poll.sh"
sudo cp "$REPO_DIR/deploy/dream-coach.service" /etc/systemd/system/dream-coach.service
sudo cp "$REPO_DIR/deploy/dream-coach-poll.service" /etc/systemd/system/dream-coach-poll.service
sudo cp "$REPO_DIR/deploy/dream-coach-poll.timer" /etc/systemd/system/dream-coach-poll.timer
# %h does not expand for system units; pin the invoking user's home explicitly.
sudo sed -i "s|%h|$HOME|g" /etc/systemd/system/dream-coach.service /etc/systemd/system/dream-coach-poll.service
sudo systemctl daemon-reload
sudo systemctl enable --now dream-coach.service
sudo systemctl enable --now dream-coach-poll.timer

echo "== 5/6 caddy vhost"
if ! sudo grep -q "$MCP_HOST" /etc/caddy/Caddyfile; then
  sudo tee -a /etc/caddy/Caddyfile < "$REPO_DIR/deploy/Caddyfile.dream" >/dev/null
  sudo systemctl reload caddy
fi

echo "== 6/6 verify"
sleep 2
curl -fsS --max-time 6 http://127.0.0.1:8130/api/admin/health && echo
curl -fsS --max-time 15 "https://$MCP_HOST/api/admin/health" && echo
echo "bootstrap complete — poller tracks origin/main every 3 minutes"
echo "NEXT: point the Vercel /api rewrite at https://$MCP_HOST/api/:path* and"
echo "      decommission the legacy :3001 unit when ready (see deployment.md)."
