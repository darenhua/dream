#!/bin/bash
# Deploy the backend to the VM. Run from the repo root:
#   bash scripts/deploy-backend.sh
# Gated on typecheck + tests. Persistent state on the VM (data/, workspace/,
# .env) is excluded from sync and protected from --delete.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "== gate: typecheck + tests"
(cd backend && bunx tsc --noEmit -p . && bun test) > /dev/null
echo "   clean"

echo "== rsync backend/ -> vm:~/dream/backend/"
rsync -az --delete \
  -e "ssh -o ClearAllForwardings=yes" \
  --exclude node_modules/ \
  --exclude data/ \
  --exclude workspace/ \
  --exclude .env \
  --exclude .cursor/ \
  backend/ vm:~/dream/backend/

echo "== install deps + restart service"
ssh -o ClearAllForwardings=yes vm 'cd ~/dream/backend && ~/.bun/bin/bun install --silent && sudo systemctl restart dream-backend'

echo "== health poll"
for i in $(seq 1 10); do
  if curl -sf --max-time 5 http://100.48.129.170:3001/api/admin/health > /tmp/dream-health.json 2>/dev/null; then
    echo "   healthy:" && cat /tmp/dream-health.json && echo
    exit 0
  fi
  sleep 2
done
echo "   health check FAILED — inspect: ssh vm journalctl -u dream-backend -n 50" >&2
exit 1
