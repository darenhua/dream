import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "../db";
import { outboundMessage, witness } from "../db/schema";
import { getConfig } from "./config";
import { emit } from "./events";

// The approval gate + durable queue. Invariants:
//   - nothing reaches a transport without status=approved (human or autosend)
//   - one message per dedupeKey per episode (pending/approved/sent block re-enqueue)
//   - notBefore respects each witness's quiet hours in THEIR timezone

export type OutboundRow = typeof outboundMessage.$inferSelect;

export function listOutbound(status?: string): OutboundRow[] {
  const cond = status
    ? eq(outboundMessage.status, status as OutboundRow["status"])
    : inArray(outboundMessage.status, ["pending_approval", "approved", "failed"]);
  return db.select().from(outboundMessage).where(cond).orderBy(desc(outboundMessage.createdAt)).all();
}

// Quiet hours in the witness's own timezone: if now falls inside the window,
// notBefore = the window's end today/tomorrow; else null (send whenever).
function computeNotBefore(witnessTimezone: string): string | null {
  const quiet = getConfig<{ start: string; end: string } | null>("WITNESS_QUIET_HOURS");
  if (!quiet) return null;
  const now = new Date();
  const local = new Intl.DateTimeFormat("en-GB", {
    timeZone: witnessTimezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(now); // "HH:MM"
  const inQuiet =
    quiet.start > quiet.end
      ? local >= quiet.start || local < quiet.end // window crosses midnight
      : local >= quiet.start && local < quiet.end;
  if (!inQuiet) return null;
  // Minutes until the quiet window ends, computed on the witness's clock.
  const [nh, nm] = local.split(":").map(Number) as [number, number];
  const [eh, em] = quiet.end.split(":").map(Number) as [number, number];
  let minutes = (eh - nh) * 60 + (em - nm);
  if (minutes <= 0) minutes += 24 * 60;
  return new Date(now.getTime() + minutes * 60_000).toISOString();
}

export function enqueueOutbound(fields: {
  witnessId: string;
  kind: OutboundRow["kind"];
  bodyText: string;
  contextJson?: unknown;
  relatedType?: string;
  relatedId?: string;
  dedupeKey?: string;
}): OutboundRow | null {
  if (fields.dedupeKey) {
    const existing = db
      .select({ id: outboundMessage.id })
      .from(outboundMessage)
      .where(
        and(
          eq(outboundMessage.dedupeKey, fields.dedupeKey),
          inArray(outboundMessage.status, ["pending_approval", "approved", "sent"]),
        ),
      )
      .get();
    if (existing) return null; // this episode already has its message
  }
  const w = db.select().from(witness).where(eq(witness.id, fields.witnessId)).get();
  if (!w) throw new Error(`witness ${fields.witnessId} not found`);

  const autosend = getConfig<boolean>("WITNESS_AUTOSEND");
  // Strike alerts skip approval BY DESIGN: if the user has vanished, nobody
  // is there to approve — flipping STRIKE_ALERTS_ENABLED (in daylight) was
  // the consent, and the body is a zero-LLM template of derived facts.
  // Review shares always stay hand-approved; autosend covers the light kinds.
  const status =
    fields.kind === "strike_alert" ||
    (autosend && (["random_prompt", "experiment_announcement", "duty_ping"] as OutboundRow["kind"][]).includes(fields.kind))
      ? "approved"
      : "pending_approval";

  const row = db
    .insert(outboundMessage)
    .values({
      witnessId: fields.witnessId,
      kind: fields.kind,
      bodyText: fields.bodyText,
      contextJson: fields.contextJson ? JSON.stringify(fields.contextJson) : null,
      relatedType: fields.relatedType ?? null,
      relatedId: fields.relatedId ?? null,
      dedupeKey: fields.dedupeKey ?? null,
      status,
      notBefore: computeNotBefore(w.timezone),
    })
    .returning()
    .get();
  emit("outbound_message", row.id, "outbound_enqueued", { kind: fields.kind, witnessId: fields.witnessId, status });
  return row;
}

export function approveOutbound(id: string, editedBody?: string): OutboundRow | null {
  const row = db.select().from(outboundMessage).where(eq(outboundMessage.id, id)).get();
  if (!row || row.status !== "pending_approval") return null;
  const updated = db
    .update(outboundMessage)
    .set({ status: "approved", ...(editedBody !== undefined ? { bodyText: editedBody } : {}) })
    .where(eq(outboundMessage.id, id))
    .returning()
    .get();
  emit("outbound_message", id, "outbound_approved", {});
  return updated;
}

export function patchOutbound(id: string, bodyText: string): OutboundRow | null {
  const row = db.select().from(outboundMessage).where(eq(outboundMessage.id, id)).get();
  if (!row || row.status !== "pending_approval") return null;
  return db.update(outboundMessage).set({ bodyText }).where(eq(outboundMessage.id, id)).returning().get();
}

export function cancelOutbound(id: string): boolean {
  const row = db.select().from(outboundMessage).where(eq(outboundMessage.id, id)).get();
  if (!row || row.status === "sent") return false;
  db.update(outboundMessage).set({ status: "cancelled" }).where(eq(outboundMessage.id, id)).run();
  emit("outbound_message", id, "outbound_cancelled", {});
  return true;
}

// Re-scoping a witness must not leak already-composed content.
export function cancelPendingForWitness(witnessId: string): number {
  const rows = db
    .update(outboundMessage)
    .set({ status: "cancelled" })
    .where(
      and(
        eq(outboundMessage.witnessId, witnessId),
        inArray(outboundMessage.status, ["pending_approval", "approved"]),
      ),
    )
    .returning({ id: outboundMessage.id })
    .all();
  if (rows.length > 0) {
    emit("witness", witnessId, "outbound_cancelled_on_rescope", { count: rows.length });
  }
  return rows.length;
}

export function markSent(id: string, transportMessageId: string) {
  db.update(outboundMessage)
    .set({ status: "sent", sentAt: new Date().toISOString(), transportMessageId })
    .where(eq(outboundMessage.id, id))
    .run();
  emit("outbound_message", id, "outbound_sent", { transportMessageId });
}

export function markFailed(id: string, error: string) {
  db.update(outboundMessage).set({ status: "failed", error }).where(eq(outboundMessage.id, id)).run();
  emit("outbound_message", id, "outbound_failed", { error });
}

// Approved rows whose notBefore has passed, joined with a linked chat.
export function sendableOutbound(): (OutboundRow & { chatId: string | null })[] {
  const now = new Date().toISOString();
  return db
    .select()
    .from(outboundMessage)
    .where(eq(outboundMessage.status, "approved"))
    .all()
    .filter(r => r.notBefore === null || r.notBefore <= now)
    .map(r => ({
      ...r,
      chatId: db.select({ chatId: witness.chatId }).from(witness).where(eq(witness.id, r.witnessId)).get()?.chatId ?? null,
    }));
}
