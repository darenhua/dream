#!/bin/bash
# Deploy the Photon iMessage messenger daemon to the VM. Run from repo root:
#   bash scripts/deploy-messenger.sh
# The daemon runs side by side with the backend (its own systemd unit,
# installed by vm-setup.sh). Its .env (PROJECT_ID/SECRET) lives only on the
# VM and is never synced. Going live also needs TRANSPORT=external in the
# backend config (PATCH /api/config) — until then the daemon idles harmlessly.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "== gate: typecheck"
(cd messenger && bunx tsc --noEmit -p .) > /dev/null
echo "   clean"

echo "== rsync messenger/ -> vm:~/dream/messenger/"
rsync -az --delete \
  -e "ssh -o ClearAllForwardings=yes" \
  --exclude node_modules/ \
  --exclude .env \
  messenger/ vm:~/dream/messenger/

echo "== install deps + restart service"
ssh -o ClearAllForwardings=yes vm 'cd ~/dream/messenger && ~/.bun/bin/bun install --silent && sudo systemctl restart dream-messenger'

echo "== last log lines"
ssh -o ClearAllForwardings=yes vm 'journalctl -u dream-messenger -n 12 --no-pager'
echo "== done — ensure messenger/.env has PROJECT_ID/SECRET and backend config TRANSPORT=external to go live"
