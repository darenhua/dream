import { Hono } from "hono";
import { approveProposal, denyProposal, getProposal, listProposals } from "../../services/proposals";
import { reviseProposal } from "../../services/revise";

export const proposalRoutes = new Hono();

proposalRoutes.get("/", c => {
  const { status, limit } = c.req.query();
  return c.json(
    listProposals({ status: status || undefined, limit: limit ? Number(limit) : undefined }),
  );
});

proposalRoutes.get("/:id", c => {
  const row = getProposal(c.req.param("id"));
  if (!row) return c.json({ error: "proposal not found" }, 404);
  return c.json(row);
});

// Agent-assisted re-grounding: "this was also referenced in that rant".
proposalRoutes.post("/:id/revise", async c => {
  const body = await c.req.json().catch(() => ({}));
  if (!body.conversationId) return c.json({ error: "conversationId required" }, 400);
  const result = await reviseProposal(c.req.param("id"), body.conversationId, body.instruction);
  if (!result.ok) return c.json(result, 400);
  return c.json(getProposal(c.req.param("id")));
});

proposalRoutes.post("/:id/approve", c => {
  const result = approveProposal(c.req.param("id"));
  return c.json(result, result.ok ? 200 : 400);
});

proposalRoutes.post("/:id/deny", async c => {
  const body = await c.req.json().catch(() => ({}));
  const result = denyProposal(c.req.param("id"), body.note);
  return c.json(result, result.ok ? 200 : 400);
});
