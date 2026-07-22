# Agent onboarding prompt

*Paste the prompt below (between the rules) at the start of any agent
session that will work on Dream. It teaches the reading order and the
conventions of the docs tree.*

---

You are working on **Dream**, Daren's personal life-organization system
(Bun + Hono + SQLite backend, React dashboard, an MCP server for
conversational use). Before writing any code or making any plan, read these
documents **in this order** — later docs assume the earlier ones:

1. `docs/product/dream-product-model.md` — what the system is for: the
   record ontology, three-level planning, themes vs tasks, accountability,
   calendar responsibilities. Read this first even for a "purely technical"
   task; most technical choices here encode product decisions.
2. `docs/architecture/agent-and-mcp-principles.md` — the rules for how
   agents touch the system: the review membrane, echo-back-before-writes,
   record/FK reuse, read-vs-write source-of-truth boundaries, and the
   friction→tickets loop.
3. `docs/architecture/environments-and-delivery.md` — how the app runs and
   ships: current state (one VM, pm2, auto-migrating SQLite) vs target
   state (staging, tagged prod deploys, scripts library, agent access).
   The deployment VM is NOT reachable from coding sessions — VM work ships
   as scripts plus a runbook.
4. `docs/backlog/post-merge-review.md` — the structured backlog (INFRA / MCP
   / PLAN / ACC / CAL / DASH items with acceptance criteria and code
   links). If your task matches an item, its AC is your definition of done.
5. `docs/handoffs/post-large-pr.md` — what the big merged PR built, the
   load-bearing decisions, known rough edges, what must NOT be casually
   rewritten, and the recommended sequencing.

How to read these files:

- **Status tags:** untagged statements are implemented and verified in the
  codebase. **[TARGET]** = agreed direction, not built. **[UNCERTAIN]** = an
  interpretation to confirm with Daren before building on it.
  **[DECISION OPEN]** = deliberately unresolved; do not pick a side
  silently — surface it.
- **Backlog IDs** (e.g. MCP-1, INFRA-5) are the shared vocabulary across
  all five docs; cite them in commits, PRs, and questions.
- **Deeper detail** lives in the repo-root design docs, in authority order:
  `REWORK_SPEC.md` → `SCHEMA_AND_SURVEYS.md` → `CONVERSATION_FLOWS.md` →
  `IMPLEMENTATION_PLAN.md` → `MASTER_CHECKLIST.md`. Consult them when a
  docs/ file references a mechanism you need to touch. Root
  `deployment.md` is trustworthy for VM/ops facts but describes the deleted
  old pipeline — read it for ops, not product shape.
- **Agent-facing behavior** is defined in
  `backend/src/mcp/dreamServer.ts` (`DREAM_SERVER_INSTRUCTIONS` rules 1–11,
  per-model `SURVEYS`, `OPERATION_CONTRACT`). That file is the source of
  truth for what the MCP tells agents; the docs explain why.

Hard rules, always:

- Never edit applied migrations (`backend/drizzle/`); schema changes are
  new, additive-only migrations. Daren runs live in prod.
- Respect the items in `post-large-pr.md` §4 ("what should not be casually
  rewritten"); propose, don't unilaterally change.
- Verify with: `cd backend && bunx tsc --noEmit`; then
  `DB_PATH=<scratch>/dream.db bun test` (scratch DB — tests wipe tables);
  then `cd dashboard && bun run build` (the dashboard gate — its
  `tsc --noEmit` fails on known environment issues; ignore those).
- Use Bun everywhere (`bun`, `bunx`, `bun test`) per `backend/CLAUDE.md`.

State which docs and backlog IDs your plan relies on before you start.
