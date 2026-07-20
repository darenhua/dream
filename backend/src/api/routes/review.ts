import { Hono } from "hono";
import {
  applyRecordChangeSet,
  getRecordChangeSet,
  listRecordChangeSets,
  reconcileRecordChangeSet,
  rejectRecordChangeSet,
} from "../../services/recordChangeSets";
import { runStructured } from "../../services/agentRunner";
import { env } from "../../lib/env";

// The review inbox: every MCP-created change set lands here; the dashboard is
// the only place a change set can be applied. No auth ceremony — the
// dashboard is the trusted local surface.
export const reviewRoutes = new Hono();

reviewRoutes.get("/", c => {
  const { status } = c.req.query();
  return c.json(listRecordChangeSets(status));
});

reviewRoutes.get("/:id", c => {
  const row = getRecordChangeSet(c.req.param("id"));
  return row ? c.json(row) : c.json({ error: "change set not found" }, 404);
});

// Kick (or re-kick) the AI reconciliation pass. Falls back to
// candidates-only when no inference credentials are configured.
reviewRoutes.post("/:id/reconcile", async c => {
  const hasInference = env.USE_BEDROCK || env.ANTHROPIC_API_KEY.length > 0;
  const report = await reconcileRecordChangeSet(c.req.param("id"), {
    runner: hasInference ? runStructured : undefined,
  });
  return report ? c.json(report) : c.json({ error: "change set not found or not ready" }, 404);
});

reviewRoutes.post("/:id/apply", async c => {
  const body = await c.req.json().catch(() => ({}));
  const result = applyRecordChangeSet(c.req.param("id"), body.verdicts);
  return c.json(result, result.ok ? 200 : 409);
});

reviewRoutes.post("/:id/reject", async c => {
  const body = await c.req.json().catch(() => ({}));
  try {
    const row = rejectRecordChangeSet(c.req.param("id"), {
      feedback: body.feedback,
      returnToDrafting: Boolean(body.returnToDrafting),
    });
    return row ? c.json(row) : c.json({ error: "change set not found" }, 404);
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 409);
  }
});
