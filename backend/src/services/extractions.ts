import { and, asc, eq, isNotNull, isNull } from "drizzle-orm";
import { db } from "../db";
import { conversation, extraction } from "../db/schema";
import { ExtractionKind } from "../domain/schemas";
import { emit } from "./events";

// The evidence layer. Drafted by the distiller, curated by the human exactly
// once, frozen forever at confirm. Agents never touch extraction rows after
// creation; only the pre-confirm human review may edit.

export class FrozenExtractionError extends Error {
  constructor(id: string) {
    super(`extraction ${id} is confirmed and frozen — extractions are immutable facts about the rant`);
  }
}

export function listExtractions(opts: { conversationId?: string; kind?: string; confirmed?: boolean }) {
  const conds = [];
  if (opts.conversationId) conds.push(eq(extraction.conversationId, opts.conversationId));
  if (opts.kind) conds.push(eq(extraction.kind, opts.kind as typeof extraction.$inferSelect.kind));
  if (opts.confirmed === true) conds.push(isNotNull(extraction.confirmedAt));
  if (opts.confirmed === false) conds.push(isNull(extraction.confirmedAt));
  return db
    .select()
    .from(extraction)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(asc(extraction.createdAt))
    .all();
}

export function getExtraction(id: string) {
  return db.select().from(extraction).where(eq(extraction.id, id)).get() ?? null;
}

// Manual add during review — a passage the agent missed.
export function addManualExtraction(fields: {
  conversationId: string;
  kind: string;
  text: string;
  startIdx?: number | null;
  endIdx?: number | null;
}) {
  const kind = ExtractionKind.parse(fields.kind);
  const convo = db.select().from(conversation).where(eq(conversation.id, fields.conversationId)).get();
  if (!convo) throw new Error(`conversation ${fields.conversationId} not found`);
  const row = db
    .insert(extraction)
    .values({
      conversationId: fields.conversationId,
      kind,
      text: fields.text,
      startIdx: fields.startIdx ?? null,
      endIdx: fields.endIdx ?? null,
      contentHash: convo.contentHash ?? "",
      origin: "manual",
    })
    .returning()
    .get();
  emit("extraction", row.id, "extraction_added_manually", { conversationId: fields.conversationId });
  return row;
}

export function patchExtraction(id: string, patch: { text?: string; kind?: string }) {
  const row = getExtraction(id);
  if (!row) return null;
  if (row.confirmedAt) throw new FrozenExtractionError(id);
  const set: Record<string, string> = {};
  if (patch.text !== undefined) set.text = patch.text;
  if (patch.kind !== undefined) set.kind = ExtractionKind.parse(patch.kind);
  const updated = db.update(extraction).set(set).where(eq(extraction.id, id)).returning().get();
  emit("extraction", id, "extraction_edited", { fields: Object.keys(set) });
  return updated;
}

export function deleteExtraction(id: string): boolean {
  const row = getExtraction(id);
  if (!row) return false;
  if (row.confirmedAt) throw new FrozenExtractionError(id);
  db.delete(extraction).where(eq(extraction.id, id)).run();
  emit("extraction", id, "extraction_deleted", { conversationId: row.conversationId, text: row.text });
  return true;
}

// Human gate #1 done: freeze the set, stamp the conversation, and let the
// caller kick derive (kept out of here so tests can confirm without an agent).
export function confirmExtractions(conversationId: string): { confirmed: number } {
  const convo = db.select().from(conversation).where(eq(conversation.id, conversationId)).get();
  if (!convo) throw new Error(`conversation ${conversationId} not found`);
  if (!convo.distilledAt) throw new Error("conversation has not been distilled yet");
  const now = new Date().toISOString();
  const frozen = db
    .update(extraction)
    .set({ confirmedAt: now })
    .where(and(eq(extraction.conversationId, conversationId), isNull(extraction.confirmedAt)))
    .returning({ id: extraction.id })
    .all();
  db.update(conversation)
    .set({ extractionsReviewedAt: now })
    .where(eq(conversation.id, conversationId))
    .run();
  emit("conversation", conversationId, "extractions_confirmed", { confirmed: frozen.length });
  return { confirmed: frozen.length };
}
