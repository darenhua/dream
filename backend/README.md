# dream backend

Bun + Hono + Drizzle (bun:sqlite). One process serves the API; the daily job
is the same codebase invoked as a CLI entrypoint.

## The pipeline

```
import conversations.json
  → parse (active-path reconstruction) → slug detected OR admin request-distill
  → DISTILL (agent): transcript → typed extractions (drafts)
  → EXTRACTION REVIEW (human gate 1): edit/add/delete → confirm → frozen forever
  → DERIVE (agent): this rant's extractions + the whole confirmed corpus
      + current state → proposals citing extraction ids
  → PROPOSAL REVIEW (human gate 2): approve/deny
      approve = mutation + permanent entity↔extraction provenance
  → goals / habits / environment / experiences / experiment queue
  → pick a queued experiment → schedule-agent chat (places tasks + habit
      blocks into real free time) → commit → google calendar → running
  → end with succeeded|failed + notes → goal attempt heatmap + trajectory
```

Derive runs once per rant — no scheduled re-interpretation. Silence in =
silence out.

## Run

```bash
bun install
bun run dev        # API on :3001 (hot reload); `bun run serve` for prod
bun run daily      # the cron entrypoint (distill → derive → writeup → sync)
bun test           # in-memory DB, no agent calls
bun run db:generate  # regenerate drizzle migration after schema changes
```

`.env` (see `.env.example`): `DB_PATH`, `WORKSPACE_PATH`, `PORT`, inference
provider (`USE_BEDROCK` + AWS credential chain, or `ANTHROPIC_API_KEY`),
`USE_PROXY`/`PROXY_URL`, and for calendar sync `GOOGLE_CLIENT_ID` +
`GOOGLE_CLIENT_SECRET` (a **Desktop app** OAuth client; keep the consent
screen in Testing mode with yourself as a test user, or refresh tokens expire
in 7 days).

## Google Calendar connect (one-time)

```bash
# on the box (or with the port forwarded: ssh -L 8765:localhost:8765 <ec2>)
bun run scripts/gcal-auth.ts
```

Fallback: open the printed consent URL anywhere, let the localhost redirect
fail, copy the `code` query param, and `POST /api/calendar/auth/token
{"code": "..."}` (also available in the admin dashboard's calendar panel).

The system writes only to a dedicated "dream" calendar it creates; your other
calendars are read read-only (freebusy) for free-time computation. Anchors
(wake/work/sleep taps) override the configured day windows per day and trigger
a deterministic, blame-free reshuffle of today's remaining blocks.

## Cold start

1. `POST /api/admin/reset` → `POST /api/admin/seed-config`
2. Connect Google Calendar (above); set day windows via `PATCH /api/config`
   or the admin panel.
3. Import the historical `conversations.json` (slugged rants distill
   immediately; mark older threads with `POST /api/conversations/:id/request-distill`).
4. Review extractions (gate 1) → derive runs → review proposals (gate 2).
5. Approve an `experiment_propose` → pick it from the queue → schedule chat →
   commit → it's running and on the calendar.
6. Cron: `0 21 * * * cd /srv/dream/backend && bun run daily`
