import { and, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { db } from "../db";
import { conversation, extraction } from "../db/schema";
import { DeriverOutput } from "../domain/schemas";
import { runStructured } from "./agentRunner";
import { getConfig } from "./config";
import { emit } from "./events";
import { newWorkspace, projectDerive } from "./projector";
import { createProposal, supersedePending } from "./proposals";

// Pass 2 of the pipeline: extractions × current state → proposals. Runs once
// per reviewed rant; the new rant is the trigger, the whole confirmed corpus
// is the evidence, so proposals may cite extractions across many rants.

export function pendingDerives() {
  return db
    .select()
    .from(conversation)
    .where(and(isNotNull(conversation.extractionsReviewedAt), isNull(conversation.derivedAt)))
    .all();
}

export async function deriveConversation(conversationId: string, trigger: "daily" | "manual") {
  const convo = db.select().from(conversation).where(eq(conversation.id, conversationId)).get();
  if (!convo) throw new Error(`conversation ${conversationId} not found`);
  if (!convo.extractionsReviewedAt) throw new Error("extractions have not been reviewed yet");
  if (convo.derivedAt) throw new Error("conversation already derived — use rederive to run again");

  const dir = newWorkspace("deriver");
  projectDerive(conversationId, dir);
  const run = await runStructured("deriver", dir, DeriverOutput, { trigger });

  if (run.status !== "ok" || !run.output) {
    emit("conversation", conversationId, "derive_failed", { agentRunId: run.runId, error: run.error });
    return { conversationId, proposals: 0, status: run.status, error: run.error };
  }

  // Grounding is the contract: every proposal must cite real confirmed extractions.
  const citedIds = [...new Set(run.output.proposals.flatMap(p => p.extraction_ids))];
  const known = new Set(
    citedIds.length
      ? db
          .select({ id: extraction.id })
          .from(extraction)
          .where(and(inArray(extraction.id, citedIds), isNotNull(extraction.confirmedAt)))
          .all()
          .map(r => r.id)
      : [],
  );
  const grounded = run.output.proposals.filter(p => p.extraction_ids.every(id => known.has(id)));
  const rejected = run.output.proposals.length - grounded.length;

  const cap = getConfig<number>("MAX_PROPOSALS_PER_DERIVE");
  const accepted = grounded.slice(0, cap); // importance-ordered; overflow dropped
  for (const p of accepted) {
    createProposal(p.kind, p, `conversation:${conversationId}`, run.runId);
  }
  db.update(conversation)
    .set({ derivedAt: new Date().toISOString() })
    .where(eq(conversation.id, conversationId))
    .run();
  emit("conversation", conversationId, "derived", {
    agentRunId: run.runId,
    proposals: accepted.length,
    rejectedUngrounded: rejected,
  });
  return { conversationId, proposals: accepted.length, rejectedUngrounded: rejected, status: "ok" as const };
}

export async function derivePendingReviewed(trigger: "daily" | "manual") {
  const pending = pendingDerives();
  const results = [];
  for (const convo of pending) {
    try {
      results.push(await deriveConversation(convo.id, trigger));
    } catch (e) {
      results.push({
        conversationId: convo.id,
        proposals: 0,
        status: "failed" as const,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return { processed: results.length, results };
}

// Admin re-derive: the ONLY surviving supersession — this conversation's
// still-pending proposals are replaced by the fresh run's view.
export async function rederiveConversation(conversationId: string) {
  const convo = db.select().from(conversation).where(eq(conversation.id, conversationId)).get();
  if (!convo) throw new Error(`conversation ${conversationId} not found`);
  if (!convo.extractionsReviewedAt) throw new Error("extractions have not been reviewed yet");
  const superseded = supersedePending(`conversation:${conversationId}`);
  db.update(conversation).set({ derivedAt: null }).where(eq(conversation.id, conversationId)).run();
  const result = await deriveConversation(conversationId, "manual");
  return { ...result, superseded };
}
