import { Hono } from "hono";
import { getConfig, setConfig } from "../../services/config";
import { handleInbound } from "../../services/messaging/inbound";
import { markFailed, markSent, sendableOutbound } from "../../services/outbox";

// The wire API for the side-by-side messenger daemon (messenger/ at repo
// root, running on the always-on Mac). The daemon is a dumb pipe: it polls
// sendable rows, publishes the Mac's real group chats, sends over iMessage,
// and relays inbound. Every decision stays in here.
export const messagingRoutes = new Hono();

// Approved rows past notBefore with a linked chat — ready for the wire.
// Empty unless TRANSPORT="external": exactly one wire owns delivery at a time
// (the in-process mock flush is the owner otherwise — never both).
messagingRoutes.get("/outbound/sendable", c => {
  if (getConfig<string>("TRANSPORT") !== "external") return c.json([]);
  const rows = sendableOutbound()
    .filter(r => r.chatId !== null)
    .map(r => ({ id: r.id, chatId: r.chatId, kind: r.kind, bodyText: r.bodyText }));
  return c.json(rows);
});

messagingRoutes.post("/outbound/:id/sent", async c => {
  const body = await c.req.json().catch(() => ({}));
  markSent(c.req.param("id"), body.transportMessageId ?? "unknown");
  return c.json({ ok: true });
});

messagingRoutes.post("/outbound/:id/failed", async c => {
  const body = await c.req.json().catch(() => ({}));
  markFailed(c.req.param("id"), body.error ?? "unknown transport error");
  return c.json({ ok: true });
});

// The daemon publishes the Mac's real group chats; the dashboard offers them
// as a picker. Group chatIds encode Messages.app internals and must never be
// constructed — they only ever come from here or from an inbound message.
messagingRoutes.post("/groups", async c => {
  const body = await c.req.json().catch(() => ({}));
  if (!Array.isArray(body.groups)) return c.json({ error: "groups[] required" }, 400);
  setConfig("MESSENGER_GROUPS", { publishedAt: new Date().toISOString(), groups: body.groups });
  return c.json({ ok: true, count: body.groups.length });
});

messagingRoutes.get("/groups", c => {
  return c.json(getConfig<{ publishedAt: string; groups: unknown[] } | null>("MESSENGER_GROUPS") ?? { publishedAt: null, groups: [] });
});

messagingRoutes.post("/inbound", async c => {
  const body = await c.req.json().catch(() => ({}));
  if (typeof body.chatId !== "string" || typeof body.senderHandle !== "string" || typeof body.text !== "string") {
    return c.json({ error: "chatId, senderHandle, text required" }, 400);
  }
  const result = handleInbound({
    chatId: body.chatId,
    senderHandle: body.senderHandle,
    text: body.text,
    sentAt: body.sentAt,
    messageId: body.messageId,
  });
  return c.json(result);
});
