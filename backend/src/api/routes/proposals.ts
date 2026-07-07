import { Hono } from "hono";
import { approveProposal, denyProposal, listProposals } from "../../services/proposals";

export const proposalRoutes = new Hono();

proposalRoutes.get("/", c => {
  const { status, limit } = c.req.query();
  return c.json(
    listProposals({ status: status || undefined, limit: limit ? Number(limit) : undefined }),
  );
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
