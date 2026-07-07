import { and, eq, isNull, notExists, sql } from "drizzle-orm";
import { db } from "../db";
import { conversation, rantLink } from "../db/schema";
import { CategorizerOutput } from "../domain/schemas";
import { runStructured } from "./agentRunner";
import { emit } from "./events";
import { newWorkspace, projectConversation } from "./projector";
import { createProposal } from "./proposals";

// §7.1 — the entire work queue.
export function pendingCategorizations() {
  return db
    .select()
    .from(conversation)
    .where(
      and(
        eq(conversation.slugDetected, true),
        isNull(conversation.categorizeProcessedAt),
        notExists(
          db
            .select({ one: sql`1` })
            .from(rantLink)
            .where(eq(rantLink.conversationId, conversation.id)),
        ),
      ),
    )
    .all();
}

// §8.2 — project → categorize → write one bundled proposal → stamp processed.
export async function processPendingCategorizations(trigger: "daily" | "manual") {
  const pending = pendingCategorizations();
  const results: { conversationId: string; status: string }[] = [];

  for (const convo of pending) {
    const dir = newWorkspace("categorizer");
    projectConversation(convo.id, dir);
    const run = await runStructured("categorizer", dir, CategorizerOutput, { trigger });

    if (run.status !== "ok" || !run.output) {
      // Leave categorize_processed_at null — the next daily run retries.
      results.push({ conversationId: convo.id, status: run.status });
      continue;
    }

    createProposal(
      "categorization",
      {
        ...run.output,
        conversation_id: convo.id,
        source_conversation_ids: [convo.id],
      },
      `conversation:${convo.id}`,
      run.runId,
    );
    db.update(conversation)
      .set({ categorizeProcessedAt: new Date().toISOString() })
      .where(eq(conversation.id, convo.id))
      .run();
    emit("conversation", convo.id, "categorization_proposed", { agentRunId: run.runId });
    results.push({ conversationId: convo.id, status: "ok" });
  }

  return { processed: results.length, results };
}
