import { Hono } from "hono";
import {
  applyCompanionBranchDraft,
  bearerTokenFromRequest,
  getCompanionBranchDraftForReview,
  listCompanionBranchDrafts,
  rejectCompanionBranchDraft,
  resolveCompanionIdentity,
  type CompanionIdentity,
} from "../../services/companion";

/**
 * Trusted-entry peer header. The Bun entrypoint strips any inbound value and
 * sets it from the socket peer address, so the loopback-owner adapter cannot
 * be spoofed through a forwarded header. In-process tests set it explicitly.
 */
export const PEER_ADDRESS_HEADER = "x-dream-peer-address";

/**
 * The companion inbox is behind the same fail-closed reviewer identity as the
 * companion MCP endpoint: the app has no general dashboard user identity, so
 * without this boundary a public deployment could apply drafts anonymously.
 */
function reviewerIdentity(request: Request): CompanionIdentity | null {
  return resolveCompanionIdentity({
    bearerToken: bearerTokenFromRequest(request),
    peerAddress: request.headers.get(PEER_ADDRESS_HEADER),
  });
}

export const companionRoutes = new Hono<{ Variables: { companionIdentity: CompanionIdentity } }>();

companionRoutes.use("*", async (c, next) => {
  const identity = reviewerIdentity(c.req.raw);
  if (!identity) {
    return c.json({ error: "companion access is not configured or the credential is invalid" }, 401);
  }
  c.set("companionIdentity", identity);
  await next();
});

companionRoutes.get("/drafts", c => c.json(listCompanionBranchDrafts(c.get("companionIdentity"))));

companionRoutes.get("/drafts/:id", c => {
  const draft = getCompanionBranchDraftForReview(c.get("companionIdentity"), c.req.param("id"));
  return draft ? c.json(draft) : c.json({ error: "companion branch draft not found" }, 404);
});

companionRoutes.post("/drafts/:id/apply", c => {
  const result = applyCompanionBranchDraft(c.get("companionIdentity"), c.req.param("id"));
  if (!result.ok) {
    return c.json({ error: result.error }, result.error.includes("not found") ? 404 : 409);
  }
  return c.json(result);
});

companionRoutes.post("/drafts/:id/reject", async c => {
  const body = await c.req.json().catch(() => ({}));
  const result = rejectCompanionBranchDraft(c.get("companionIdentity"), c.req.param("id"), {
    feedback: typeof body.feedback === "string" ? body.feedback : undefined,
    returnToDrafting: body.returnToDrafting === true,
  });
  if (!result.ok) {
    return c.json({ error: result.error }, result.error.includes("not found") ? 404 : 409);
  }
  return c.json(result);
});
