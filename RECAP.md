# RECAP — organized MCP workspaces: full session history, intent, and reset guide

**Audience:** a review agent working on a fresh branch cut from the commit that
added this file. Read this top to bottom before touching anything. It tells you
(1) what was built and why, (2) every problem hit along the way and how it was
solved, (3) how to `git reset` back to any earlier point so you can re-attempt a
phase yourself with only the intent as your guide, then compare against the
shipped solution.

**Branch:** `codex/organized-mcp-workspaces` · **Draft PR:** https://github.com/darenhua/dream/pull/5
**Authoritative product context (untracked, in the worktree — do not commit, do not delete):**
`REVISED_MEGA_SPEC.md` (the contract; supersedes `MEGA_SPEC.md`),
`IMPLEMENTATION_HANDOFF.md`, `IMPLEMENTATION_PLAN_CHECKLIST.md`,
`CODEBASE_RESEARCH.md`, `MCP_COMPANION_DESIGN.md`, `thoughts/**`.

---

## 0. How to rewind (read this before any reset)

Your branch is cut from the commit containing this RECAP. The session's commits,
oldest → newest:

| commit | what it delivered |
|---|---|
| `4270cc6` | **session starting point** — reviewed current-focus workflow (pre-existing) |
| `74c87aa` | Phase 4a: group lineage + reversible archive |
| `cb1940f` | Phase 4b: persistent no-code branch companion |
| `4ad7cbe` | Phase 5: real localhost Streamable HTTP MCP trajectories |
| `d9b7ee3` | fixes from the independent trajectory review (peer-header spoof, transcript redaction) |
| `a2e620f` | conversation-UX fixes from the two-agent simulation (submit gating, init instructions, open loops) |
| this commit | deploy/ CI-CD + TLS artifacts (NOT yet run on the VM) + this RECAP |

To re-attempt a phase yourself: `git reset --hard <the commit BEFORE it>`, then
implement from the intent described below, then diff against the original
(`git diff <original-commit> -- <paths>`). Examples:

```sh
git reset --hard 4270cc6   # rewind everything; re-do phase 4a onward
git reset --hard 74c87aa   # keep lineage/archive; re-do the companion
git reset --hard cb1940f   # keep companion; re-do the trajectory gate
git reset --hard 4ad7cbe   # re-do the security/redaction fixes from the review findings
git reset --hard d9b7ee3   # re-do the conversation-UX fixes from the simulation findings
```

Safety rules for resets in THIS worktree:
- `reset --hard` is safe here **only because** the spec/handoff docs, `thoughts/`,
  and `backend/data/` are untracked — they survive resets. **Never run
  `git clean`** (it would delete them). Never `git add -A`.
- You are on your own branch; the original branch and PR keep the full history.
  Nothing you do is destructive to the shipped work.
- One wrinkle if you rewind to `4270cc6`: at the true session start,
  `backend/src/api/httpServer.ts` + `backend/test/httpServer.test.ts` existed
  **untracked** (an injectable Bun.serve factory for the future trajectory
  phase) and `backend/src/db/schema.ts` + `backend/src/services/organized.ts`
  carried a deliberately incomplete lineage patch that **broke `tsc`**
  (self-referential Drizzle FK ⇒ TS7022 "implicitly has type 'any'"). After
  your reset those files are simply at their committed `4270cc6` state — clean
  but featureless. If you want the authentic starting condition, recreate the
  broken patch from §1 below; otherwise just start phase 4a from clean.

Verification loop used throughout (run before claiming any phase done):

```sh
cd backend && bunx tsc --noEmit
tmpdir=$(mktemp -d); DB_PATH="$tmpdir/dream.db" bun test; rc=$?; rm -rf "$tmpdir"; (exit $rc)
cd ../dashboard && bunx tsc --noEmit && env -u HTTP_PROXY -u HTTPS_PROXY bun run build
```

(The `env -u` matters: the local shell exports a proxy that stalls bun installs/builds.)

---

## 1. Phase 4a — group lineage + reversible archive (`74c87aa`)

**Intent.** A "branch" is a new candidate change group with an immutable parent
link; archive hides a noncurrent group without deleting anything. Critically,
the *generic* creator contracts must LOSE authority: parent lineage may only
ever be created by the companion (phase 4b), and lifecycle (done/sunset/archive)
only by reviewed Sunset or explicit dashboard archive.

**What was done.**
- `experiment_group` gained `parent_experiment_group_id` (self-FK), `archived_at`,
  `archived_from_status`, parent index → migration `0017` (three nullable ADD
  COLUMNs, FK `no action`, loss-free for existing rows).
- `GroupOperationSchema` and `prioritize.selection.new` (`organized.ts`):
  **removed** `status`, `closingReviewMd`, `parentExperimentGroupId`; made both
  `.strict()` so a smuggled field is a hard error, not silently stripped
  (otherwise "schemas reject a parent field" is untestable).
- `archiveExperimentGroup` / `restoreExperimentGroup`: refuse current/active/
  already-archived/live-actionable; restore only to recorded pre-archive state
  (explicit `restoreAs` required when that's null); never to `active`; both
  side-effect-free for focus/ranks/calendar/messaging. Dashboard-only routes
  `POST /api/organized/groups/:id/{archive,restore}`.
- `groupView` gained shallow `parent`/`children`; feed hides archived but
  returns `archivedGroups` + real `archivedGroupCount` (fixed a pre-existing
  always-zero count bug — backend filtered archived rows before the UI counted).
- Dashboard: "branched from …" breadcrumbs (cards, current focus, detail
  modal with clickable lineage chips), archive buttons, archived view w/ restore.
- Tests: `backend/test/groupLineage.test.ts` (checklist-mandated invariants).

**Problems hit → solutions.**
- *TS7022 self-referential FK*: `references(() => experimentGroup.id)` on the
  same table makes inference recursive. Fix: type the callback
  `references((): AnySQLiteColumn => experimentGroup.id)`.
- *13 test failures "no column named parent_experiment_group_id"*: schema
  declared columns before migration 0017 existed (test DBs build from
  migrations). Generate the migration, failures vanish.
- *TS excess-property error in tests*: intentionally-invalid literals (the
  smuggled parent field) trip compile-time checks — cast via `as unknown as …`.

## 2. Phase 4b — persistent no-code branch companion (`cb1940f`)

**Intent.** A second, deliberately different MCP surface: persistent, code-free,
domain-read-only, whose ONLY write is one quarantined `companion_branch_draft`
after an explicit user ask. Never reuse creator plumbing; authenticate every
request. (User decision that day: **no** "related existing-organized updates"
in branch drafts — new ideas become new branches, never in-place rewrites.)

**What was done.**
- `companion_branch_draft` table (migration `0018`), identity-owned; also added
  to `wipeAllTables` in `src/db/index.ts` (forgetting this caused a test bleed —
  see problems).
- `services/companion.ts`: fail-closed `resolveCompanionIdentity` — sha256-hashed
  bearer token (constant-time compare, `COMPANION_AUTH_TOKEN_SHA256`) OR
  loopback-owner adapter (`COMPANION_ALLOW_LOOPBACK_OWNER`, loopback socket
  peers only); both map to one owner subject. Strict
  `create_experiment_group_branch` op schema (mandatory existing parent — may
  be archived; child always `candidate`). Save revises the ONE open draft
  (dashboard feedback → same draft, never a second entity). Atomic apply /
  reject / return-to-drafting. Organized-first read models: overview, search,
  context, relations, provenance.
- `mcp/companionServer.ts`: 8 tools, initialize-level instructions, and a
  per-session **discovered-reference allowlist**: `follow_provenance` on a raw
  ref is refused until an organized read returned that ref (defense in depth
  against arbitrary-ID dumps).
- `mcp/companionHttp.ts`: independent session map; auth on EVERY request
  including continuations (session id must never become a bearer token);
  continuation identity must match the bound identity. Shared *stateless*
  helpers (origin/host policy, CORS hygiene) extracted to `mcp/transport.ts`
  and reused by the creator host — session maps and authority models stay
  fully separate.
- Inbox routes `/api/companion/*` behind the same reviewer identity; loopback
  is proven by a trusted-entry header `x-dream-peer-address` that ONLY the Bun
  entry sets from the socket peer (see phase-5 security fix). Dashboard
  "companion branch drafts" card with parent breadcrumb, seed, full diff,
  whole-draft apply.
- Tests: `backend/test/companion.test.ts` — auth matrix (unconfigured/wrong
  token/non-loopback/unauthenticated continuation all fail with **zero**
  sessions created), tool-surface isolation (no creator tools; foreign session
  ids 404), quarantine (no group before apply), contract rejections (every
  non-branch mutation), identity scoping, atomic apply.

**Problems hit → solutions.**
- *Test bleed*: a draft from one test survived `wipeAllTables` into the next —
  the new table wasn't in the wipe list. Add `companion_branch_draft` first in
  the children-first ordering.
- *Design tension (inbox auth without any dashboard user system)*: resolved via
  the pluggable identity + trusted peer header pattern rather than inventing a
  login system; multi-user requires real OAuth (documented gate, fail-closed).

## 3. Phase 5 — real localhost Streamable HTTP trajectories (`4ad7cbe`)

**Intent.** Release gate per spec §12.6: a deterministic mock conversational
agent must drive the REAL production dispatcher over genuine localhost
Streamable HTTP (Bun.serve on `127.0.0.1:0`, real socket peer path), including
the real dashboard review/apply HTTP boundary — not in-process `handle()` calls.
Persist REDACTED transcripts for independent review.

**What was done.**
- Finished the pre-existing uncommitted `httpServer.ts` harness: routes `/mcp`
  and `/companion-mcp` with the socket peer, stamps the trusted peer header
  for `/api/companion`. Committed here together with the trajectory work.
- `backend/test/trajectories.test.ts`: 6 trajectories = (1) blank creator +
  code-linked index → organized goal; (2) group design must preserve
  user-selected goal scope, zero calendar/witness writes; (3) actionable reads
  the prior FAILED week review before drafting; (4) companion branch with no
  domain row before apply; (5) reviewed Pick→Sunset across overlapping groups ⇒
  exactly one active group + ordered goal set; (6) dashboard feedback revises
  the SAME draft. Transcript recorder with secret redaction writes artifacts to
  untracked `thoughts/trajectories/run-*/`.

**Problems hit → solutions.**
- *Bun `new Request(request, { headers })` MERGES init.headers over the
  original* — a deleted spoofed header silently survived. Rebuild the request
  from its URL instead.
- *Trajectories passed alone, failed in the full run*: `mcp.test.ts` has
  `afterEach(() => configureCollaborationMcpBackend(null))`, unhooking the MCP
  domain adapter for every later file. The trajectory `beforeAll` must
  re-register the production backend.
- *`weekOf` must be a real Monday* — computed, not hardcoded.

## 4. Independent trajectory review + fixes (`d9b7ee3`)

**Intent.** Spec §12.6's second half: a FRESH independent agent adversarially
audits transcripts/prompts/tool traces/code against the spec; material findings
must be fixed and affected trajectories rerun.

**Findings (both real) → fixes.**
1. **Encoded-path bypass of peer-header sanitization.** The entry gated
   sanitization on `URL.pathname.startsWith("/api/companion")`, but Hono
   percent-decodes routes while `URL.pathname` does not ⇒ `/api/%63ompanion/…`
   reached the companion inbox with a spoofed loopback header intact (owner
   impersonation, since `BIND_HOST` defaults public). Fix: strip/stamp the
   header on EVERY app-bound request, no path predicate; regression tests
   include the exact encoded-path attack end-to-end (expects 401).
2. **Credentials recorded before redaction registration.** The invite-issuing
   response (one-time code + dashboard capability) was logged before
   `t.secret()` ran ⇒ cleartext in the very artifacts required to be redacted.
   Fix: structural scrub of secret-bearing keys (`code`, `dashboardCapability`,
   `authorization`, `token`, `secret`) independent of registration order; all
   trajectories regenerated; reviewer re-verified both fixes → final verdict
   **PASS**.

**Also done in this stretch (uncommitted checks):** browser verification on an
isolated seeded stack (ports 3900/3901, scratch DB — the real `backend/data`
and the user's live servers on 3000/3001 untouched): archive→restore round
trip, companion inbox review→atomic apply→lineage breadcrumb + provenance
modal, and both live chat flows (dashboard one-time code → real MCP client
redeem/index/search/draft/submit → "your review is required" → apply; and a
code-free companion conversation landing a new inbox draft).

## 5. Two-agent conversation simulation + fixes (`a2e620f`)

**Intent (user's explicit ask).** For EVERY MCP skill, simulate the real thing:
a "human" subagent in the user's voice — vague, lazy, remembers NOTHING of the
database — converses with a FRESH blank-agent subagent per skill that can learn
only through the real MCP over localhost (a curl bridge exposing /meta + /call;
forbidden from reading the repo). Judge whether instructions + tool text alone
let a blank agent hold a contextualized conversation, then fix the prompts.

**Conversations run (all transcripted in `thoughts/agent-sim/run-2026-07-16/`):**
organized_goal, organized_habit, organized_environment, experiment_group (user
pastes a party rant), actionable_experiment ("be gentle, last week was rough"),
prioritize sunset, prioritize pick, companion (no code, improv shower thought).
Human verdicts 4–5/5; membrane held everywhere; standouts: C4 caught a
forgotten duplicate group and asked supersede-vs-scope; C5 read the failed week
review and made success "texts sent," not replies; C8 presented the three
outcomes (context-only / branch draft / raw-proposal route) and waited for the
explicit ask.

**Findings → fixes (then re-verified with a fresh blank agent).**
1. **Premature submit (systematic).** Three independent blank agents saved AND
   submitted right after Q&A — because the instruction text literally said
   "save one complete atomic draft, then submit it." Fix in
   `instructions.ts` universal + `server.ts` next_steps: summarize the change
   set in-conversation and WAIT for an explicit go-ahead; answers to questions
   are not a go-ahead; dashboard feedback counts as the go-ahead for a revised
   resubmission.
2. **No initialize-level instructions on the creator endpoint**
   (`server_instructions: null`; companion already had them). Fix:
   `CREATOR_SERVER_INSTRUCTIONS` on the `McpServer` constructor.
3. **Open-loops blindness** (human's #1 systemic gap): pending unapplied
   drafts/workspaces were invisible, so the pick conversation offered a
   superseded group without acknowledging its pending replacement. Fix: every
   `get_workspace_index` read now APPENDS a live "Open loops (unapplied work)"
   section — computed at READ time in `serializeWorkspaceIndex`, never frozen
   into the immutable snapshot (that placement was itself a review finding:
   the first draft baked it into the stored markdown ⇒ stale + unbounded).
   Bounded (20 + overflow line), `compact()`-sanitized against markdown
   injection via multi-line seeds, status-derived phrasing, single-user
   identity caveat documented for the future multi-identity filter.

A sub-review of this diff (another subagent) produced findings 2/3's shape:
read-time computation, bounding/sanitization, the drafting-vs-review phrasing,
and the go-ahead/feedback tension — all folded in. New test: "workspace index
surfaces other open loops live, sanitized, without leaking this workspace"
(gotcha: only a REDEEMED invite is an open loop — unredeemed invites have no
workspace row).

## 6. Deployment stream (THIS commit — artifacts only, VM not yet touched)

**User decisions (recorded verbatim intent):** VM-side git poller CI/CD; the
creator MCP public over HTTPS so Claude can add it as a connector, companion
token-gated (single user, "no worries about privacy"); iMessage/spectrum-kit
stays dark on the VM (macOS-only; the client may later talk to a localhost
daemon); **PR #5 merges to main first**, then CI/CD tracks main.

**VM reconnaissance facts (2026-07-17, `ssh vm`):** Ubuntu AWS box, public IP
`100.48.129.170` (`100-48-129-170.nip.io` resolves; :80 reachable ⇒ Let's
Encrypt viable). Caddy running but only proxying an unrelated app (`:80→:8787`).
A LEGACY backend systemd unit `dream-backend` serves OLD pre-MCP code from
`~/dream/backend` on `:3001` (Vercel's `/api` rewrite still points there).
`~/deployments/dream-coach/` exists from a 2026-07-15 prep (secrets seeded at
`~/deployments/.secrets/dream-coach/secrets.env`) but is an rsync target — **no
git checkout, no gh, no Actions runner anywhere on the VM**. Port `8130` free
by convention; `3001` occupied by the legacy unit. Root `deployment.md` is the
authoritative prior deploy doc (ports, secrets table, gotchas, legacy cutover).

**Artifacts added under `deploy/` (written, LINTED-BY-EYE, not yet executed):**
`dream-coach.service` (loopback :8130), `dream-coach-poll.sh` (fetch main →
gate `tsc` + isolated `bun test` → restart → health poll; failure leaves the
previous version live), `dream-coach-poll.{service,timer}` (3-min timer),
`Caddyfile.dream` (nip.io vhost, exact forwarded headers `MCP_TRUST_PROXY`
expects, SSE-friendly timeouts), `vm-bootstrap.sh` (idempotent: clone, append
MCP env + generate companion token→hash into secrets, install units, append
Caddy vhost, verify health over TLS).

**REMAINING WORK (in order) — none of it done yet:**
1. Merge PR #5 into `main` (user said they'd do it / authorize it).
2. Run `deploy/vm-bootstrap.sh` on the VM; verify `https://100-48-129-170.nip.io/api/admin/health`,
   then a real MCP initialize against `…/mcp` from outside.
3. Point the Vercel `/api/:path*` rewrite at the nip.io origin (currently
   `:3001` legacy); redeploy frontend.
4. Decommission legacy: `sudo systemctl disable --now dream-backend`, remove the
   old `21:00 daily` cron line; keep/move the 09:00 heartbeat cron to the new
   checkout path.
5. Data: the new service starts with a FRESH DB unless you migrate
   `~/dream/backend/data/dream.db` → `~/deployments/dream-coach-git/backend/data/`
   (then Google Calendar OAuth re-connect if the refresh-token row is absent).
6. Add the companion connector token (from `~/deployments/.secrets/dream-coach/companion-token.txt`)
   to the MCP client config; add the creator connector URL `https://100-48-129-170.nip.io/mcp`
   to Claude as a public connector.
7. Update `deployment.md` gotchas after cutover; consider a follow-up PR.

## 7. Invariants you must never violate (condensed)

Raw proposal-derived rows are evidence; the USER initiates every organized
thing. Agents draft only; the dashboard's atomic apply is the sole domain
write. Two MCP surfaces, never blurred: creator (dashboard code + versioned
index) vs companion (code-free, read-only + one quarantined branch draft after
an explicit ask). Exactly one current focus / active group; reviewed Pick and
Sunset are the only lifecycle path. Branches: companion-only, immutable parent;
archive hides, never deletes/cascades/activates. Actionables: manual, weekly,
current-group-only; calendar/witness stay behind their own confirmation
membranes; heartbeat notifies only. Never commit the untracked spec/handoff
docs, `thoughts/**`, `backend/data/**`. Small targeted commits; never `git add -A`.
