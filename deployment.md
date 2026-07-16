# deployment: dream-coach

## What this is

A single-user self-coaching system ("Dream System"): rants exported from the Claude app are classified, distilled into human-confirmed extractions, and derived into goals/habits/experiments; a witness system shares goal-scoped updates with accountability friends. Shape: **backend** (Bun + Hono + SQLite, one process, all agents inside) + **frontend** (static React dashboard built by Bun, all `/api/*` calls proxied/rewritten to the backend). A daily **heartbeat** cron does the work that can't be event-driven (strike checks, duty pings, outbox flush).

## Deploy targets

- frontend: repo root → Vercel (existing project `dream-coach`, team `darenhuas-projects`); root `vercel.json` holds install/build commands and the `/api/*` rewrite → **the rewrite destination must point at the backend's VM port** (see Gotchas — it currently says `:3001`, the legacy port)
- backend: `backend/src/api/server.ts` (`bun run serve`) → VM, HTTP on `$PORT`; it defaults to `BIND_HOST=0.0.0.0` for the legacy direct API setup, but the recommended TLS-proxied deployment binds it to `127.0.0.1`

## Runtimes

Built and verified with: bun 1.3.14 (VM) / 1.3.5 (dev — no incompatibilities observed), no node needed anywhere. Python/uv unused.

## Env vars

| var | needed by | purpose / where to get it |
|---|---|---|
| PORT | backend | injected by service.sh — do NOT put in secrets.env |
| BIND_HOST | backend | `127.0.0.1` when the reverse proxy is the public boundary; default `0.0.0.0` preserves the old direct setup |
| DB_PATH | backend | sqlite file; MUST be `./data/dream.db` so state survives rsync `--delete` |
| WORKSPACE_PATH | backend | agent-run audit dirs; set `./data/workspace` (default `./workspace` is NOT rsync-safe) |
| USE_BEDROCK | backend | `true` → AWS Bedrock (the production setup) |
| AWS_REGION | backend | `us-west-2` (model aliases are region-specific inference profiles) |
| AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY | backend | Bedrock auth on the VM (it has no `~/.aws`; both the classic SDK and the Vercel AI SDK read these from env) |
| ANTHROPIC_API_KEY | backend | fallback provider when `USE_BEDROCK=false`; kept seeded |
| USE_PROXY | backend | `false` on the VM (also actively clears inherited proxy vars) |
| GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET | backend | Google Calendar OAuth (Desktop-app client from console.cloud.google.com) |
| MCP_PUBLIC_URL | backend | public **HTTPS origin** for cloud MCP, e.g. `https://mcp.example.com` (no `/mcp` suffix) |
| MCP_ALLOWED_HOSTS | backend | exact public MCP host, e.g. `mcp.example.com`; rejects unexpected Host headers |
| MCP_ALLOWED_ORIGINS | backend | comma-separated browser origins only when browser MCP access is intended; leave blank for server-to-server clients |
| MCP_TRUST_PROXY | backend | `true` only when the backend is private behind a proxy that overwrites `X-Forwarded-*`; otherwise `false` |
| MCP_SESSION_IDLE_MINUTES / MCP_MAX_SESSIONS | backend | short-lived MCP capability/session bounds (defaults: 30 minutes / 100) |
| MCP_REDEEM_MAX_ATTEMPTS / MCP_REDEEM_WINDOW_MINUTES / MCP_REDEEM_MAX_TRACKED_CLIENTS | backend | OTP brute-force and memory bounds (defaults: 8 / 15 / 10000) |

Secrets: **seeded to the VM store (`~/deployments/.secrets/dream-coach/secrets.env`, 10 vars) on 2026-07-15**, composed from the proven legacy `~/dream/backend/.env` plus the Google OAuth pair. Frontend needs no env (the rewrite is in `vercel.json`).

## Remote MCP endpoint (cloud ChatGPT / Claude)

`/mcp` is a stateful Streamable HTTP endpoint, not an `/api/*` route. The
current Vercel rewrite only forwards `/api/*`, so it does **not** expose MCP.
Give the cloud client a dedicated HTTPS URL such as
`https://mcp.example.com/mcp`; never give it the VM's clear-text `:8130` URL.

Recommended production boundary:

1. Put a TLS reverse proxy in front of the backend, route both `/api/*` and
   `/mcp` through it, set `BIND_HOST=127.0.0.1`, and firewall port 8130 from
   public networks. This prevents a caller from bypassing the proxy and
   spoofing its forwarded headers.
2. Set `MCP_PUBLIC_URL=https://mcp.example.com`,
   `MCP_ALLOWED_HOSTS=mcp.example.com`, and `MCP_TRUST_PROXY=true`. Leave
   `MCP_ALLOWED_ORIGINS` empty for normal server-to-server MCP clients. If a
   browser MCP client genuinely needs CORS, list each exact origin (for
   example `https://chatgpt.com`) instead of using `*`.
3. The endpoint permits only MCP's `GET`, `POST`, and `DELETE` methods (plus
   CORS preflight), returns `Cache-Control: no-store`, validates Host/Origin,
   caps live sessions, expires idle sessions, and rate-limits OTP redemption.
   Those application checks complement—never replace—the private backend and
   TLS proxy boundary.

Minimal Nginx shape (TLS certificate directives omitted):

```nginx
server {
  listen 443 ssl http2;
  server_name mcp.example.com;

  location = /mcp {
    proxy_pass http://127.0.0.1:8130;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    # Overwrite, do not append: MCP_TRUST_PROXY relies on these values.
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_buffering off;
    proxy_read_timeout 3600s;
  }
}
```

If the old direct-VM API path must remain temporarily, leave
`MCP_TRUST_PROXY=false` until the backend is private. The MCP rate limiter
will then key off the actual socket peer rather than an attacker-supplied
forwarded header, at the cost of coarser limits behind a shared proxy.

## Reproduce in a clean checkout (verified 2026-07-15)

From a fresh checkout, at the project root:

1. `cd backend && bun install`
2. (no build step — Bun runs TS directly; drizzle migrations auto-apply at process start)
3. `PORT=8130 DB_PATH=./data/dream.db WORKSPACE_PATH=./data/workspace bun run serve`
4. Verify: `curl -s localhost:8130/api/admin/health` → `{"ok":true,"conversations":0,...}` (a fresh sqlite file appears under `backend/data/`)

Frontend (what Vercel runs, verified locally):

1. `cd dashboard && bun install`
2. `bun run build` → static site in `dashboard/dist/` (~250ms)

## VM sequence (run these ONLY, after rsync)

Rsync the `backend/` directory to `~/deployments/dream-coach/` (exclude `node_modules`, `data/`, `workspace/`, `.env`). Then:

1. `cd ~/deployments/dream-coach && ~/.bun/bin/bun install --frozen-lockfile`
2. install secrets: `cp ~/deployments/.secrets/dream-coach/secrets.env ~/deployments/dream-coach/.env`
3. `~/deployments/service.sh start dream-coach 8130 ~/deployments/dream-coach -- ~/.bun/bin/bun run serve`
4. Verify from outside: `curl -s http://100.48.129.170:8130/api/admin/health` → `{"ok":true,...}`
5. Heartbeat cron (the strike tripwire — required for the product, not for the process):
   `crontab -l | { cat; echo "0 9 * * * cd ~/deployments/dream-coach && ~/.bun/bin/bun run heartbeat >> ~/deployments/dream-coach/data/heartbeat.log 2>&1"; } | crontab -` (with `CRON_TZ=America/New_York` present once in the crontab)
6. Frontend cutover: edit root `vercel.json` rewrite destination to `http://100.48.129.170:8130/api/:path*`, commit, then `bunx vercel deploy --yes` from the repo root (Vercel CLI auth = the user runs `vercel login` when the token is stale; the Vercel MCP connector also works).

rsync notes: only `backend/` ships to the VM (source + `bun.lock` + `drizzle/`); the frontend goes to Vercel from git. `drizzle/` MUST ship — migrations apply from it at boot.

## State / persistence

- `backend/data/` — the sqlite DB (+ WAL/SHM) and, with `WORKSPACE_PATH=./data/workspace`, the agent-run audit dirs. All under `data/` → safe across `--delete` redeploys.
- The `google_auth` row (OAuth refresh token) and all app content live in the DB. **Fresh deploy = fresh DB**: on first boot import a conversations.json and reconnect Google Calendar (admin → calendar panel; on a remote box use the code-paste fallback or `ssh -L 8130:localhost:8130`, since the OAuth redirect targets `localhost:$PORT`).
- Legacy default `WORKSPACE_PATH=./workspace` writes OUTSIDE data/ — the secrets.env override handles this; if you drop the override, add `--exclude workspace/` to redeploys.

## Gotchas

- **A legacy deployment is live on the VM**: systemd unit `dream-backend` serving the OLD code at `~/dream/backend` on **port 3001**, plus an old `0 21 * * * … bun run daily` crontab line. The Vercel rewrite currently points at it. After the new service verifies on 8130: `sudo systemctl disable --now dream-backend`, remove the old cron line, update the vercel.json rewrite (step 6). Until then the old app keeps working — the cutover is atomic at the rewrite.
- **Port**: do not deploy the new service on 3001 (taken by the legacy unit until decommissioned). This doc assumes **8130**.
- `PORT` must NOT appear in `.env`/secrets.env — Bun's `.env` loading would not override the exported `$PORT`, but keeping it out avoids the ambiguity entirely.
- **Local-machine only**: the developer's shell exports a proxy that stalls `bun install` — reproduce locally with `env -u HTTP_PROXY -u HTTPS_PROXY bun install`. The VM has no proxy; `USE_PROXY=false` in secrets also clears any inherited proxy vars at runtime.
- Bedrock model IDs are cross-region inference profiles (`us.anthropic.…`); bare `anthropic.…` IDs 400. Aliases live in `backend/src/services/agentRunner.ts`; diagnostics: `bun run scripts/bedrock-spike.ts` (classic SDK) and `bun run scripts/aisdk-spike.ts` (AI SDK streaming).
- The deriver's schema exceeds Bedrock's structured-output grammar limit; `runStructured` auto-falls back to schema-in-prompt + zod. Expected occasionally in `agent_run` logs (`status: ok` after fallback) — not a failure.
- First boot on an empty DB is instant (migrations ~ms); no long builds anywhere.
- Config knob `AUTO_DETECT` (admin → config): flip **false before** bulk-importing the historical conversations.json (import stays inert; classify at your own pace in the admin rant explorer), back to true for daily use.
- The witness/strike system ships dark by design: `STRIKE_ALERTS_ENABLED=false` until a primary witness chat is linked; the messaging transport is a mock until Photon (spectrum-ts) is configured — nothing to set up at deploy time.

## Untested

- The exact `service.sh start` invocation and external `curl http://100.48.129.170:8130/...` (this session verified the identical command shape locally on a clean checkout binding `0.0.0.0:8130`, and the VM runs the same code fine under the legacy unit — but the new-convention start itself hasn't been executed).
- `bunx vercel deploy` was not run this session (last verified 2026-07-08 per SPEC amendment 11); the dashboard build it wraps was verified clean today.
- Heartbeat cron line under the new path (the identical entrypoint runs on the legacy cron today).
