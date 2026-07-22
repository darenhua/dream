# Environments and delivery

*Written 2026-07-22, post PR #6. Split hard into CURRENT STATE (verified
against the codebase and deployment history) and TARGET STATE (agreed
direction from the post-merge review — not built). The deployment VM is NOT
accessible from coding sessions; anything touching it ships as scripts + docs
that Daren runs there. Status tags per `docs/product/dream-product-model.md`.*

> Related reading: root `deployment.md` is the old system's deploy runbook.
> Its **env-var table, VM runtime facts, and Gotchas remain the best record**
> of the real machine, but its architecture narrative (rant classification →
> extraction → derivation, Vercel frontend, legacy port 3001) describes the
> **deleted** pipeline — read it for ops facts, not product shape. `RECAP.md`
> holds the older VM recon (Caddy, nip.io, unexecuted `deploy/` artifacts).

---

## 1. CURRENT STATE (verified)

**One VM, one prod, everything manual.**

- **Processes (pm2):** dashboard via `bun run dev`, backend via
  `bun src/api/server.ts`. The single backend process hosts the REST API,
  the Dream MCP at `/mcp` (Streamable HTTP, no auth), and the Google OAuth
  callback (`/api/calendar/oauth/callback`).
- **Boot requires zero env vars.** SQLite (`bun:sqlite`, WAL, FKs on) is
  created at `DB_PATH` (default `./data/dream.db`) and **drizzle migrations
  run automatically at module load** (`runMigrations()` in
  `backend/src/db/index.ts`). Applied migrations live in `backend/drizzle/`
  (currently through `0020_puzzling_gamma_corps.sql`).
- **Env vars that matter in prod:** see the table in `deployment.md` —
  notably `DB_PATH` (must survive deploys), `USE_BEDROCK` + AWS creds (the
  reconciliation agent), `GOOGLE_CLIENT_ID/SECRET`, `PUBLIC_URL` /
  `MCP_PUBLIC_URL`, `PORT`, `BIND_HOST`.
- **Heartbeat:** `POST /api/jobs/daily` or `bun run heartbeat` from cron —
  strikes, duty pings, calendar housekeeping (inbound sync + failed-push
  retry sweep + `pushPendingEvents(50)`). Optional; nothing breaks without
  it except retries and pings.
- **Deploys are manual:** git pull on the VM, restart pm2 processes. This is
  exactly what the review notes call out as unacceptable.
- **Verification loop (any environment):**
  `cd backend && bunx tsc --noEmit` →
  `tmpdir=$(mktemp -d); DB_PATH="$tmpdir/dream.db" bun test` (must be a
  scratch DB — tests wipe tables) →
  `cd dashboard && bun run build`. The dashboard's `tsc --noEmit` fails on
  pre-existing environment/TS-version issues; **`bun run build` is the
  dashboard gate**.

### Migration + data-preservation discipline (in force today, by convention)

Daren runs live in prod while the schema evolves. Rules already being
followed, to be encoded in scripts:

- **Additive-only migrations** (or additive + backfill, like 0019's
  `lineage_id = id` backfill). Never edit an applied migration. Legacy
  column drops are deferred indefinitely.
- **Snapshots are WAL-safe backups:** `sqlite3 dream.db ".backup '<dest>'"`,
  never a raw file copy of a live DB.
- **Rehearse against a prod copy** before deploying schema changes: restore
  a snapshot locally/staging, boot (migrations auto-run), eyeball data, run
  smoke checks.

---

## 2. TARGET STATE: environments **[TARGET]**

Four environments, one philosophy: *make it dead easy to ship.*

| Env | Where | Code | Database | Purpose |
|---|---|---|---|---|
| local | dev machine | working tree | scratch/seeded SQLite | development |
| ephemeral | remote coding sessions (e.g. Claude Code cloud VMs) | branch under work | scratch/seeded SQLite | agent development; must reach parity with local via one setup command |
| staging | **the same VM as prod** | latest `main`, auto-deployed on every merge | own `DB_PATH`, periodically restored from prod snapshots | test redeployment + data migration against realistic data, always-latest playground |
| prod | the VM | **tagged commits on main only** | the real `./data/dream.db` | Daren's live system |

**[UNCERTAIN: staging process layout.]** Straightforward reading: staging is
a second pair of pm2 apps on different ports with its own `DB_PATH` and its
own MCP URL. Confirm before building (alternatives: separate user account,
containers).

- **Database isolation:** every environment has its own SQLite file; no
  environment ever points at another's `DB_PATH`. Staging gets realism by
  **restoring prod snapshots on demand** (a script), never by sharing the
  file.
- **Migration promotion path:** dev (auto-run on boot) → staging (auto-run
  on every merge-deploy, against a recent prod copy — this IS the rehearsal)
  → prod (runs at boot of the tagged deploy, **after** an automatic
  snapshot). A migration that breaks staging blocks tagging.

## 3. TARGET STATE: CI/CD behavior **[TARGET]**

- **Staging auto-deploys on every merge to `main`.** No human steps. The
  deploy runs migrations (implicitly, at boot) and then the smoke script;
  failures are loud.
- **Prod deploys specific tagged commits on `main`** (e.g. `v*` tags or an
  explicit promote command). The deploy takes a snapshot first, then
  switches code, restarts processes, runs the smoke script.
- **No more manual git-pull-and-restart** for dashboard, server, or MCP.
- **[DECISION OPEN — backlog INFRA-7]** PR relationship: whether PRs deploy
  to staging (or a per-PR instance), and how an agent on the VM works
  against a PR's branch.
- **[UNCERTAIN: mechanism.]** GitHub Actions needs a path to the VM (SSH
  key or a VM-side poller — `RECAP.md` records unexecuted git-poller
  artifacts from the old system that may be salvageable). Requires Daren on
  the deployment machine to wire up; deliverables from coding sessions are
  the scripts + workflow files + a runbook.

## 4. TARGET STATE: the maintenance script library **[TARGET]**

Durable, boring, built once — *"we don't wanna reinvent these system
maintenance scripts all the time."* Proposed home: `scripts/` at repo root
(backend-runtime scripts may live in `backend/scripts/` beside the existing
spikes). Contracts:

| Script | Contract |
|---|---|
| `seed` | Populate a scratch DB with realistic fixture data (goals with satellites, a pick, weekly + daily plans, pending change sets) so any environment demos end-to-end. Idempotent or refuses on non-empty DB |
| `snapshot` | WAL-safe `.backup` of a target DB to a timestamped file; used standalone, by prod deploys, and by a daily backup cron |
| `restore` | Restore a snapshot into a target env's `DB_PATH`; **refuses to target prod** without an explicit `--yes-prod` flag |
| `smoke` | Health-check a running deployment: API up, MCP initialize handshake succeeds, dashboard served, DB readable, migrations current, calendar connection status reported. Exit code drives CI |
| `nuke` | Wipe an environment's DB to empty-but-migrated. Same prod guard as restore |
| `fixtures` | The seed data itself, maintained as data (not inline in the seed script) so tests and seeds share it |

Guard rail for all of them: destructive scripts identify the prod `DB_PATH`
and hard-refuse it unless explicitly overridden.

## 5. TARGET STATE: safe agent access to each environment **[TARGET]**

Agents (coding sessions, generic Claude conversations) need to *see* what's
on staging and prod without shell access:

- **Extend MCP for admin/record inspection** so a generic agent can read
  records, change sets, calendar push state, and config per environment.
  **[DECISION OPEN — backlog MCP-7 adjacent]:** a separately deployed
  **dream admin MCP** vs. admin tools on the existing Dream MCP per env.
- Each environment exposes its own MCP URL; agents **swap environments by
  swapping MCP endpoints**, and primarily work off **staging**, with
  on-demand realistic reads of prod data (via the admin MCP and the
  snapshot/restore scripts).
- Staging is the playground: test migrations, seed data freely, nuke freely.

## 6. Production read safety and write restrictions **[TARGET]**

- **Prod is read-mostly for agents.** Admin/inspection reads are fine and
  encouraged (that's the point of the admin surface).
- **Prod writes stay behind the existing membranes only:** the review inbox
  for records, the plan flows for plans/calendar. No agent-driven direct
  DB writes, no destructive maintenance scripts against prod without the
  explicit override, no schema changes outside the migration path.
- The current Dream MCP is **no-auth by design** (single user). Once staging
  and an admin surface exist on shared infrastructure, revisit exposure —
  at minimum keep the origin/host policy in `backend/src/mcp/http.ts` and
  prefer non-public binding + tunnel for admin endpoints.
  **[UNCERTAIN: whether any auth ceremony is acceptable to Daren — he has
  explicitly rejected MCP auth ceremony for the main user-facing MCP.]**
