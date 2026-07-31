#!/usr/bin/env bash
# smoke.sh <base-url> [expected-env] — health-check a running deployment.
# Verifies the API answers with ok:true (and the expected env when given) and
# that the MCP endpoint completes an initialize handshake. Exit code drives
# the poller and ship.sh; also fine to run by hand against any environment.
set -euo pipefail
base="${1:?usage: smoke.sh <base-url> [expected-env]}"
expected="${2:-}"

fail() { echo "SMOKE FAIL: $*" >&2; exit 1; }

health="$(curl -fsS --max-time 10 "$base/api/admin/health")" || fail "health unreachable at $base"
[[ "$health" == *'"ok":true'* ]] || fail "health not ok: $health"
if [[ -n "$expected" ]]; then
  [[ "$health" == *"\"env\":\"$expected\""* ]] || fail "expected env $expected, got: $health"
fi

mcp_status="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 -X POST "$base/mcp" \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}')"
[[ "$mcp_status" == "200" ]] || fail "MCP initialize returned $mcp_status (check MCP_ALLOWED_HOSTS for this host)"

echo "SMOKE OK: $base${expected:+ ($expected)}"
