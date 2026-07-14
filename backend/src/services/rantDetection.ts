import { and, eq, isNull } from "drizzle-orm";
import { db } from "../db";
import { conversation } from "../db/schema";
import type { TranscriptMessage } from "../domain/parser";
import { RantDetectorOutput } from "../domain/schemas";
import { runStructured } from "./agentRunner";
import { getConfig } from "./config";
import { emit } from "./events";
import { newWorkspace } from "./projector";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

// The intake gate, pass 0 of the pipeline: every imported conversation gets a
// cheap-model verdict (rant candidate or not), candidates surface on the
// dashboard, and a HUMAN accept — not a slug — admits it into distill.
// A detected slug is the legacy fast path: auto-accepted, no LLM spent.

export function pendingDetections() {
  return db
    .select()
    .from(conversation)
    .where(and(isNull(conversation.rantVerdict), isNull(conversation.parseError)))
    .all()
    .filter(c => c.contentJson !== null);
}

function excerpt(contentJson: string, maxChars: number): { messageCount: number; text: string } {
  const messages = JSON.parse(contentJson) as TranscriptMessage[];
  // User messages carry the signal — a rant is the user talking, not Claude.
  const userText = messages
    .filter(m => m.role === "user")
    .map(m => m.content)
    .join("\n");
  return { messageCount: messages.length, text: userText.slice(0, maxChars) };
}

type ConvoRow = typeof conversation.$inferSelect;

async function detectBatch(batch: ConvoRow[], trigger: "daily" | "manual") {
  const dir = newWorkspace("rant_detector");
  const md = batch
    .map(c => {
      const { messageCount, text } = excerpt(c.contentJson!, 1500);
      return (
        `## conversation_id: ${c.id}\n` +
        `title: ${c.title ?? "(untitled)"}\ndate: ${c.sourceUpdatedAt ?? "unknown"}\nmessages: ${messageCount}\n\n` +
        `### opening excerpt (user messages only)\n${text}\n`
      );
    })
    .join("\n---\n\n");
  writeFileSync(join(dir, "candidates.md"), md);

  const run = await runStructured("rant_detector", dir, RantDetectorOutput, {
    trigger,
    model: getConfig<string>("DETECTOR_MODEL"),
  });
  if (run.status !== "ok" || !run.output) {
    emit("import", null, "rant_detection_failed", { agentRunId: run.runId, error: run.error });
    return { detected: 0, candidates: 0, error: run.error };
  }

  const now = new Date().toISOString();
  const known = new Map(batch.map(c => [c.id, c]));
  let candidates = 0;
  for (const v of run.output.conversations) {
    if (!known.has(v.conversation_id)) continue; // grounding: only ids we sent
    const isCandidate = v.verdict === "candidate";
    if (isCandidate) candidates++;
    db.update(conversation)
      .set({
        rantVerdict: v.verdict,
        rantStatus: isCandidate ? "proposed" : null,
        rantDetectedAt: now,
        detectorNote: v.note,
      })
      .where(eq(conversation.id, v.conversation_id))
      .run();
    if (isCandidate) emit("conversation", v.conversation_id, "rant_candidate_proposed", { note: v.note });
  }
  return { detected: run.output.conversations.length, candidates };
}

export async function detectPendingRants(trigger: "daily" | "manual") {
  const pending = pendingDetections();
  if (pending.length === 0) return { processed: 0, candidates: 0, autoAccepted: 0 };

  // Legacy fast path: a slug is an explicit past request — auto-accept, no LLM.
  const slugged = pending.filter(c => c.slugDetected);
  const now = new Date().toISOString();
  for (const c of slugged) {
    db.update(conversation)
      .set({
        rantVerdict: "candidate",
        rantStatus: "accepted",
        rantDetectedAt: now,
        rantResolvedAt: now,
        detectorNote: "marker slug present — auto-accepted",
        distillRequested: true,
      })
      .where(eq(conversation.id, c.id))
      .run();
    emit("conversation", c.id, "rant_accepted", { via: "slug" });
  }

  const toClassify = pending.filter(c => !c.slugDetected);
  const batchSize = getConfig<number>("DETECTOR_BATCH_SIZE");
  let candidates = 0;
  let processed = 0;
  for (let i = 0; i < toClassify.length; i += batchSize) {
    const result = await detectBatch(toClassify.slice(i, i + batchSize), trigger);
    processed += result.detected;
    candidates += result.candidates ?? 0;
    emit("import", null, "rant_detection_progress", {
      processed: Math.min(i + batchSize, toClassify.length),
      total: toClassify.length,
    });
  }
  return { processed, candidates, autoAccepted: slugged.length };
}

// The human gate: accept admits the conversation into distill.
export function acceptRant(conversationId: string) {
  const row = db.select().from(conversation).where(eq(conversation.id, conversationId)).get();
  if (!row) throw new Error(`conversation ${conversationId} not found`);
  if (!row.contentJson) throw new Error("conversation has no parsed content");
  db.update(conversation)
    .set({
      rantVerdict: row.rantVerdict ?? "candidate", // manual accept overrides a missing/negative verdict
      rantStatus: "accepted",
      rantResolvedAt: new Date().toISOString(),
      distillRequested: true,
    })
    .where(eq(conversation.id, conversationId))
    .run();
  emit("conversation", conversationId, "rant_accepted", { via: "human" });
}

export function rejectRant(conversationId: string, note?: string) {
  const row = db.select().from(conversation).where(eq(conversation.id, conversationId)).get();
  if (!row) throw new Error(`conversation ${conversationId} not found`);
  db.update(conversation)
    .set({ rantStatus: "rejected", rantResolvedAt: new Date().toISOString() })
    .where(eq(conversation.id, conversationId))
    .run();
  emit("conversation", conversationId, "rant_rejected", { note: note ?? null });
}
