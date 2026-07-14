import { Hono } from "hono";
import { flushOutbound } from "../../services/messaging/messenger";
import { approveOutbound, cancelOutbound, listOutbound, patchOutbound } from "../../services/outbox";

export const outboxRoutes = new Hono();

outboxRoutes.get("/", c => {
  const { status } = c.req.query();
  return c.json(listOutbound(status));
});

// Approve (optionally with an edit) and flush right away — on the mock/manual
// transports flushing is instant; linked chats get the real send.
outboxRoutes.post("/:id/approve", async c => {
  const body = await c.req.json().catch(() => ({}));
  const row = approveOutbound(c.req.param("id"), typeof body.bodyText === "string" ? body.bodyText : undefined);
  if (!row) return c.json({ error: "not pending approval" }, 400);
  const flush = await flushOutbound();
  return c.json({ row, flush });
});

outboxRoutes.patch("/:id", async c => {
  const body = await c.req.json().catch(() => ({}));
  if (typeof body.bodyText !== "string") return c.json({ error: "bodyText required" }, 400);
  const row = patchOutbound(c.req.param("id"), body.bodyText);
  if (!row) return c.json({ error: "not editable" }, 400);
  return c.json(row);
});

outboxRoutes.post("/:id/cancel", c => {
  if (!cancelOutbound(c.req.param("id"))) return c.json({ error: "not cancellable" }, 400);
  return c.json({ ok: true });
});
