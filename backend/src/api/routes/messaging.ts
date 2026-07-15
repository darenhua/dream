import { and, eq, isNotNull, isNull } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "../../db";
import { witness } from "../../db/schema";
import { getConfig } from "../../services/config";
import { emit } from "../../services/events";
import { handleInbound } from "../../services/messaging/inbound";
import { markFailed, markSent, sendableOutbound } from "../../services/outbox";
import { witnessGoalTitles } from "../../services/witnessScope";

// The wire API for the side-by-side messenger daemon (messenger/ at repo
// root). The daemon is a dumb pipe: it polls sendable rows and link requests,
// sends over iMessage, and reports back. Every decision stays in here.
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

// Witnesses whose group chat the daemon should create: link requested from
// the dashboard, handle present, not yet linked. welcomeText is rendered
// HERE (deterministic template) — the daemon never composes words.
messagingRoutes.get("/link-requests", c => {
  const userHandle = getConfig<string | null>("USER_IMESSAGE_HANDLE");
  const rows = db
    .select()
    .from(witness)
    .where(and(isNotNull(witness.linkRequestedAt), isNull(witness.chatId), isNotNull(witness.handle)))
    .all();
  const template = getConfig<string>("TEMPLATE.witness_welcome");
  return c.json(
    rows.map(w => ({
      witnessId: w.id,
      name: w.name,
      handle: w.handle,
      userHandle, // daemon adds this to the group; null → daemon skips with error
      groupName: `${w.name} × dream coach`,
      welcomeText: template
        .replaceAll("{{FRIEND}}", w.name)
        .replaceAll("{{GOALS}}", witnessGoalTitles(w.id).join(", ") || "(no goals scoped yet)"),
    })),
  );
});

messagingRoutes.post("/link-requests/:witnessId/linked", async c => {
  const body = await c.req.json().catch(() => ({}));
  if (typeof body.chatId !== "string" || !body.chatId) return c.json({ error: "chatId required" }, 400);
  const id = c.req.param("witnessId");
  const row = db.select().from(witness).where(eq(witness.id, id)).get();
  if (!row) return c.json({ error: "witness not found" }, 404);
  db.update(witness)
    .set({ chatId: body.chatId, linkedAt: new Date().toISOString(), status: "active", linkRequestedAt: null })
    .where(eq(witness.id, id))
    .run();
  emit("witness", id, "witness_chat_linked", { via: "group_created", chatId: body.chatId });
  return c.json({ ok: true });
});

messagingRoutes.post("/link-requests/:witnessId/failed", async c => {
  const body = await c.req.json().catch(() => ({}));
  const id = c.req.param("witnessId");
  // Clear the request so the dashboard shows the failure instead of "linking…" forever.
  db.update(witness).set({ linkRequestedAt: null }).where(eq(witness.id, id)).run();
  emit("witness", id, "witness_link_failed", { error: body.error ?? "unknown" });
  return c.json({ ok: true });
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
