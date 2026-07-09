import { Hono } from "hono";
import {
  cancelSession,
  confirmSession,
  findOpenSession,
  getSession,
  postMessage,
} from "../../services/scheduleChat";

export const chatRoutes = new Hono();

// Find the open session for a scheduling experiment (resume after tab close).
chatRoutes.get("/sessions", c => {
  const experimentId = c.req.query("experimentId");
  if (!experimentId) return c.json({ error: "experimentId required" }, 400);
  const session = findOpenSession(experimentId);
  if (!session) return c.json({ error: "no open session" }, 404);
  return c.json(session);
});

chatRoutes.get("/sessions/:id", c => {
  const session = getSession(c.req.param("id"));
  if (!session) return c.json({ error: "session not found" }, 404);
  return c.json(session);
});

chatRoutes.post("/sessions/:id/messages", async c => {
  const body = await c.req.json().catch(() => ({}));
  if (!body.text || typeof body.text !== "string") return c.json({ error: "text required" }, 400);
  const result = await postMessage(c.req.param("id"), body.text);
  if (!result.ok) return c.json(result, 400);
  return c.json(getSession(c.req.param("id")));
});

// Commit the converged plan: experiment → running, calendar events pushed.
chatRoutes.post("/sessions/:id/confirm", async c => {
  const result = await confirmSession(c.req.param("id"));
  return c.json(result, result.ok ? 200 : 400);
});

// Bail out — free: experiment returns to the queue.
chatRoutes.post("/sessions/:id/cancel", c => {
  const result = cancelSession(c.req.param("id"));
  return c.json(result, result.ok ? 200 : 400);
});
