---
description: Manually drive the Dream CI/CD pipeline — deploy staging/prod/preview and run the ops scripts (scripts/ops/) over ssh vm
argument-hint: [staging|prod|preview <ref>|status|refresh-staging|snapshot|restore|nuke] [freeform details]
---

Drive the Dream Coach delivery pipeline manually: $ARGUMENTS

This is the CI/CD-era replacement for the old rsync-based `/deploy` flow —
never rsync, never touch `service.sh`, never deploy to `~/deployments/dream-coach`
(that is the retired pre-pipeline instance). Everything below runs the scripts
in `scripts/ops/` (see `scripts/ops/README.md` for the full contracts and the
prod-cutover runbook).

## The pipeline (what "deploy" means per environment)

| target | mechanism |
|---|---|
| **staging** | tracks `main` automatically — a merge to main deploys it within ~3 min via the VM cron poller. Manual redeploy of the current tip: `ssh vm 'bash ~/deployments/dream/staging/scripts/ops/poll.sh staging --force'` |
| **prod** | tracks the moving `release` branch. Promote with `bun run ship` from `backend/` on the laptop — it gates on staging being healthy at main's tip, warns when the range touches migrations, snapshots prod, pushes `main:release`, then waits for the prod poller and smokes. Never push `release` by hand outside `ship.sh`. |
| **preview** | one on-demand slot for any ref: `ssh vm 'bash ~/deployments/dream/preview/scripts/ops/preview.sh <branch\|sha\|pr/N> [--seed\|--from-prod]'`. If `~/deployments/dream/preview.conf` doesn't exist yet, bootstrap the slot once first: `ssh vm 'bash ~/deployments/dream/staging/scripts/ops/bootstrap-vm.sh preview --caddy'` |

## Environments on the VM (`ssh vm`, alias already configured)

- Layout: `~/deployments/dream/{staging,prod,preview}` checkouts,
  `<env>.conf` + `<env>.env.overrides` beside them, snapshots in
  `~/deployments/dream/snapshots/`, poller logs `poll-<env>.log`.
- Backends are pm2 apps `dream-<env>` bound to loopback (staging :8141,
  prod :8140, preview :8142); Caddy owns TLS at `*-api/*-mcp/*-dash.beefy-vm.com`
  (prod uses the bare `api./mcp./dashboard.` hosts).
- **PATH gotcha:** pm2 lives under Volta and is off non-interactive PATHs.
  Prefix VM commands with `export PATH="$HOME/.volta/bin:$HOME/.bun/bin:$PATH"`
  when calling pm2 or the ops scripts interactively.
- An empty `poll-<env>.log` is healthy (the poller is silent when there is
  nothing new). A failed gate logs loudly and leaves the previous version live.

## Supporting operations (all via `ssh vm`, scripts in the env's checkout)

- `status`: `curl -s https://<env-api-host>/api/admin/health` — verify `env`,
  `sha`, `sideEffectsBlocked`; plus `pm2 ls` and `tail poll-<env>.log`.
- `snapshot.sh <env>` / `restore.sh <env> <snap> [--yes-prod]` /
  `refresh-staging.sh [--fresh]` (staging ← latest prod snapshot; the
  migration rehearsal) / `nuke.sh <env>` (refuses prod without FORCE=1) /
  `smoke.sh <base-url> [expected-env]`.
- Admin MCP tokens (read-only inspection surface `/admin-mcp`):
  plaintext at `~/deployments/.secrets/dream-coach/admin-token-<env>.txt`.

## Guardrails

- Prod-affecting steps (restore --yes-prod, FORCE=1 nuke, the P3 cutover in
  `scripts/ops/README.md`) need the user's explicit go — confirm first.
- Staging/preview force the side-effect kill-switch (`APP_ENV`), so restores
  of prod snapshots there are safe: no witness messages, no calendar writes.
- After any deploy, report the health JSON (env + sha) as proof, not just
  the script's exit status.
