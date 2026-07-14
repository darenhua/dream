#!/bin/bash
# One-time (idempotent) setup of the dream backend host. Run from the repo root:
#   bash scripts/vm-setup.sh
# Creates: bun install, ~/dream/backend skeleton, .env (with AWS creds parsed
# from local ~/.aws/credentials), systemd unit (enabled, not started — the
# first deploy starts it), and the §11.9 daily cron.
set -euo pipefail

SSH=(ssh -o ClearAllForwardings=yes -o ConnectTimeout=10 vm)

echo "== bun"
"${SSH[@]}" 'command -v ~/.bun/bin/bun >/dev/null 2>&1 && ~/.bun/bin/bun --version || (curl -fsSL https://bun.sh/install | bash >/dev/null && ~/.bun/bin/bun --version)'

echo "== directories"
"${SSH[@]}" 'mkdir -p ~/dream/backend'

echo "== .env"
if "${SSH[@]}" 'test -f ~/dream/backend/.env'; then
  echo "   .env already exists on VM — leaving it untouched"
else
  AWS_KEY_ID=$(awk -F' *= *' '/^\[default\]/{d=1;next} /^\[/{d=0} d && $1=="aws_access_key_id"{print $2}' ~/.aws/credentials)
  AWS_SECRET=$(awk -F' *= *' '/^\[default\]/{d=1;next} /^\[/{d=0} d && $1=="aws_secret_access_key"{print $2}' ~/.aws/credentials)
  if [ -z "$AWS_KEY_ID" ] || [ -z "$AWS_SECRET" ]; then
    echo "   ERROR: could not parse [default] creds from ~/.aws/credentials" >&2
    exit 1
  fi
  "${SSH[@]}" "cat > ~/dream/backend/.env" <<EOF
PORT=3001
DB_PATH=./data/dream.db
WORKSPACE_PATH=./workspace
USE_BEDROCK=true
AWS_REGION=us-west-2
AWS_ACCESS_KEY_ID=$AWS_KEY_ID
AWS_SECRET_ACCESS_KEY=$AWS_SECRET
USE_PROXY=false
ANTHROPIC_API_KEY=
EOF
  "${SSH[@]}" 'chmod 600 ~/dream/backend/.env'
  echo "   .env written (chmod 600)"
fi

echo "== systemd unit"
"${SSH[@]}" 'sudo tee /etc/systemd/system/dream-backend.service > /dev/null' <<'EOF'
[Unit]
Description=Dream Coach backend (bun + hono)
After=network.target

[Service]
User=ubuntu
WorkingDirectory=/home/ubuntu/dream/backend
ExecStart=/home/ubuntu/.bun/bin/bun run serve
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
"${SSH[@]}" 'sudo systemctl daemon-reload && sudo systemctl enable dream-backend >/dev/null 2>&1'
echo "   unit installed + enabled (starts on first deploy)"

echo "== heartbeat cron (§11.9; 09:00 ET — social pings land in the morning)"
"${SSH[@]}" 'crontab -l 2>/dev/null | grep -v "dream/backend && .*bun run \(daily\|heartbeat\)" > /tmp/cron.$$ || true
grep -q CRON_TZ /tmp/cron.$$ 2>/dev/null || echo "CRON_TZ=America/New_York" >> /tmp/cron.$$
echo "0 9 * * * cd ~/dream/backend && ~/.bun/bin/bun run heartbeat >> ~/dream/heartbeat.log 2>&1" >> /tmp/cron.$$
crontab /tmp/cron.$$ && rm /tmp/cron.$$ && crontab -l | tail -2'

echo "== done — run scripts/deploy-backend.sh next"
