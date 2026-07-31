# scripts/ops — the Dream delivery + maintenance library

One parameterized toolset for every environment. On the VM, an environment is
`{~/deployments/dream/<env>.conf, <env>.env.overrides, <env>/ checkout, a pm2
app}`; `common.sh` loads that contract, everything else composes it.

| env | branch | port | pm2 app | domains |
|---|---|---|---|---|
| prod | `release` | 8140 | dream-prod | api. / mcp. / dashboard.beefy-vm.com |
| staging | `main` | 8141 | dream-staging | staging-api. / staging-mcp. / staging-dash. |
| preview | any ref | 8142 | dream-preview | preview-api. |

## The pipeline

```
PR → GitHub Actions (tsc + tests + dashboard build) → merge to main
main    → poll.sh staging (cron, 3 min): gate → build → restart → smoke
bash scripts/ops/ship.sh   (laptop; also: bun run ship from backend/)
release → poll.sh prod (cron): gate → SNAPSHOT → build → restart → smoke
```

Promotion is `git push origin main:release` — ship.sh wraps it with the
staging-at-main-tip check, a migration-rehearsal warning, a prod snapshot,
and the post-deploy smoke. Rollback: `restore.sh prod <snap> --yes-prod` +
`git push -f origin <old-sha>:release`.

## Scripts (VM unless noted)

| script | contract |
|---|---|
| `poll.sh <env> [--force]` | the CD poller; failed gate leaves the old version live |
| `bootstrap-vm.sh <env\|all> [--caddy]` | idempotent env setup: checkout, conf, admin token, first deploy, crons, pm2 save |
| `ship.sh` (laptop) | promote main → release with gates; `STAGING_HEALTH`/`PROD_HEALTH` overridable |
| `snapshot.sh <env> [--prune]` | WAL-safe `VACUUM INTO` → `snapshots/dream-<env>-<ts>.db` |
| `restore.sh <env> <snap> [--yes-prod]` | stop → swap DB (old kept as `.pre-restore-*`) → start → health |
| `refresh-staging.sh [--fresh]` | newest (or fresh) prod snapshot → staging; THE migration rehearsal |
| `preview.sh <ref> [--seed\|--from-prod]` | deploy branch/sha/`pr/N` to the preview slot |
| `smoke.sh <base> [env]` | health + expected-env + MCP initialize; exit code drives CI |
| `nuke.sh <env>` | wipe to empty-but-migrated via admin reset; prod needs `FORCE=1` |
| `bun run seed` (backend/) | fixtures into an EMPTY db: ranked goals, habits, ideas+links, deadline task |

Safety rails: prod-destructive paths hard-refuse without an explicit
override; staging/preview carry `APP_ENV` kill-switches in the backend
itself (mock transport, strikes off, calendar disconnected), so restored
prod data can never message witnesses or touch the real calendar.

## Admin MCP per environment

Each instance serves read-only `/admin-mcp` (tools: admin_env, admin_tables,
admin_select, admin_row) behind a per-env bearer token; plaintext lives in
`~/deployments/.secrets/dream-coach/admin-token-<env>.txt`, sha256 in the
env overrides. Agents swap environments by swapping MCP endpoints:
`https://staging-mcp.beefy-vm.com/admin-mcp` vs `https://mcp.beefy-vm.com/admin-mcp`.
Writes on staging go through the regular staging Dream MCP (`/mcp`).

## Runbooks

**P2 — stand up staging** (after Cloudflare grey-cloud A records for
staging-api / staging-mcp / staging-dash / preview-api → the VM):

```sh
ssh vm
git clone https://github.com/darenhua/dream.git /tmp/dream-boot   # or any checkout of main
bash /tmp/dream-boot/scripts/ops/bootstrap-vm.sh staging --caddy
bash ~/deployments/dream/staging/scripts/ops/refresh-staging.sh   # rehearsal
```

**P3 — prod cutover** (side-by-side; explicit go only):

1. `git push origin main:release`, then `bootstrap-vm.sh prod` (no --caddy yet)
2. `pm2 stop mcp` (old :3001 app) → move its `backend/data/` contents into
   `~/deployments/dream/prod/backend/data/` → `pm2 restart dream-prod`
3. smoke `http://127.0.0.1:8140` prod, then `bootstrap-vm.sh prod --caddy`
   after DELETING the old api./mcp./dashboard. blocks that point at 3001/3000
4. verify the claude.ai connector (same mcp.beefy-vm.com URL) + dashboard
5. remove the old crons (09:00 heartbeat in ~/deployments/dream-coach, 03:30
   snapshot-prod.sh) — bootstrap installed prod-checkout equivalents
6. `pm2 delete mcp nextjs-dashboard` + `pm2 save`; `pm2 startup` once
7. rollback at any point: restore old Caddy blocks, `pm2 start mcp`

**P4 — decommission**: stop the stale :8130 service.sh instance; rename its
old-world DB `dream-oldworld-2026-07.db` (KEEP); close public 3000/3001/8130;
rm `/etc/systemd/system/dream-backend.service`; archive `~/dream/backend`.
