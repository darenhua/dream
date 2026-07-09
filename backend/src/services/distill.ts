import { and, eq, isNull, or } from "drizzle-orm";
import { db } from "../db";
import { conversation, extraction } from "../db/schema";
import { DistillerOutput } from "../domain/schemas";
import { runStructured } from "./agentRunner";
import { emit } from "./events";
import { newWorkspace, projectDistill } from "./projector";

// Pass 1 of the pipeline: a pure function of the rant. Runs once per
// conversation; failures leave distilled_at null so the next daily retries.

export function pendingDistills() {
  return db
    .select()
    .from(conversation)
    .where(
      and(
        or(eq(conversation.slugDetected, true), eq(conversation.distillRequested, true)),
        isNull(conversation.distilledAt),
        isNull(conversation.parseError),
      ),
    )
    .all();
}

async function distillConversation(convo: typeof conversation.$inferSelect, trigger: "daily" | "manual") {
  const dir = newWorkspace("distiller");
  projectDistill(convo.id, dir);
  const run = await runStructured("distiller", dir, DistillerOutput, { trigger });

  if (run.status !== "ok" || !run.output) {
    emit("conversation", convo.id, "distill_failed", { agentRunId: run.runId, error: run.error });
    return { conversationId: convo.id, status: run.status, extractions: 0 };
  }

  for (const x of run.output.extractions) {
    db.insert(extraction)
      .values({
        conversationId: convo.id,
        kind: x.kind,
        text: x.text,
        startIdx: x.start_idx,
        endIdx: x.end_idx,
        contentHash: convo.contentHash ?? "",
        origin: "agent",
        agentRunId: run.runId,
      })
      .run();
  }
  db.update(conversation)
    .set({ distilledAt: new Date().toISOString() })
    .where(eq(conversation.id, convo.id))
    .run();
  emit("conversation", convo.id, "distilled", {
    agentRunId: run.runId,
    extractions: run.output.extractions.length,
  });
  return { conversationId: convo.id, status: "ok" as const, extractions: run.output.extractions.length };
}

export async function distillPending(trigger: "daily" | "manual") {
  const pending = pendingDistills();
  const results = [];
  for (const convo of pending) {
    try {
      results.push(await distillConversation(convo, trigger));
    } catch (e) {
      results.push({
        conversationId: convo.id,
        status: "failed" as const,
        extractions: 0,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return { processed: results.length, results };
}

// Admin re-distill: APPENDS new extractions (old confirmed rows are immutable
// facts and stay put, keyed by their contentHash) and reopens review + derive.
export async function redistill(conversationId: string) {
  const convo = db.select().from(conversation).where(eq(conversation.id, conversationId)).get();
  if (!convo) throw new Error(`conversation ${conversationId} not found`);
  db.update(conversation)
    .set({ distilledAt: null, extractionsReviewedAt: null, derivedAt: null })
    .where(eq(conversation.id, conversationId))
    .run();
  emit("conversation", conversationId, "redistill_requested", {});
  const fresh = db.select().from(conversation).where(eq(conversation.id, conversationId)).get()!;
  return distillConversation(fresh, "manual");
}
