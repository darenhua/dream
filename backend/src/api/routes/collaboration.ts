import { Hono, type Context } from "hono";
import {
  applyCollaborationChangeSet,
  assertDashboardChangeSetCapability,
  assertDashboardInviteCapability,
  assertDashboardWorkspaceCapability,
  createCollaborationInvite,
  getCollaborationInvite,
  getCollaborationWorkspace,
  getDraftChangeSet,
  rejectCollaborationChangeSet,
} from "../../services/collaboration";

export const collaborationRoutes = new Hono();

function dashboardCapability(c: Context) {
  return c.req.header("x-collaboration-capability") ?? null;
}

function unauthorized(c: Context) {
  return c.json({ error: "collaboration dashboard capability is invalid" }, 403);
}

// Dashboard routes: create an invite, observe MCP draft progress, and make
// the only Apply/Reject decision. The MCP transport has no route to these
// handlers and can write drafts only through its workspace-bound tools.
collaborationRoutes.post("/invites", async c => {
  const body = await c.req.json().catch(() => ({}));
  try {
    const created = createCollaborationInvite({
      mode: body.mode,
      primaryEntityId: body.primaryEntityId,
      experimentGroupId: body.experimentGroupId,
      prioritizeAction: body.prioritizeAction,
      userSeedMd: body.userSeedMd,
      selectedOrganizedGoalIds: body.selectedOrganizedGoalIds,
    });
    const { code, dashboardCapability, ...invite } = created;
    return c.json({ invite, code, dashboardCapability }, 201);
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
  }
});

collaborationRoutes.get("/invites/:id", c => {
  try {
    assertDashboardInviteCapability(c.req.param("id"), dashboardCapability(c));
  } catch {
    return unauthorized(c);
  }
  const invite = getCollaborationInvite(c.req.param("id"));
  if (!invite) return c.json({ error: "collaboration invite not found" }, 404);
  const workspace = invite.workspaceId ? getCollaborationWorkspace(invite.workspaceId) : null;
  return c.json({ invite, workspace, changeSet: workspace?.drafts[0] ?? null });
});

collaborationRoutes.get("/workspaces/:id", c => {
  try {
    assertDashboardWorkspaceCapability(c.req.param("id"), dashboardCapability(c));
  } catch {
    return unauthorized(c);
  }
  const workspace = getCollaborationWorkspace(c.req.param("id"));
  return workspace
    ? c.json({ workspace, changeSet: workspace.drafts[0] ?? null })
    : c.json({ error: "collaboration workspace not found" }, 404);
});

collaborationRoutes.get("/change-sets/:id", c => {
  try {
    assertDashboardChangeSetCapability(c.req.param("id"), dashboardCapability(c));
  } catch {
    return unauthorized(c);
  }
  const row = getDraftChangeSet(c.req.param("id"));
  return row ? c.json(row) : c.json({ error: "change set not found" }, 404);
});

collaborationRoutes.post("/change-sets/:id/apply", c => {
  try {
    assertDashboardChangeSetCapability(c.req.param("id"), dashboardCapability(c));
  } catch {
    return unauthorized(c);
  }
  const result = applyCollaborationChangeSet(c.req.param("id"));
  return result.ok ? c.json(result) : c.json(result, 400);
});

collaborationRoutes.post("/change-sets/:id/reject", async c => {
  try {
    assertDashboardChangeSetCapability(c.req.param("id"), dashboardCapability(c));
  } catch {
    return unauthorized(c);
  }
  const body = await c.req.json().catch(() => ({}));
  try {
    const changeSet = rejectCollaborationChangeSet(c.req.param("id"), {
      feedback: body.feedback,
      returnToDrafting: body.returnToDrafting,
    });
    return changeSet ? c.json({ changeSet }) : c.json({ error: "change set not found" }, 404);
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
  }
});
