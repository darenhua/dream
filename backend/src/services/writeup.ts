import { and, desc, eq, isNotNull, isNull } from "drizzle-orm";
import { db } from "../db";
import { conversation, dailyWriteup, proposal } from "../db/schema";
import { runText } from "./agentRunner";
import { emit } from "./events";
import { daysSinceLastVisit, newWorkspace, projectWriteup } from "./projector";

export function todayLocal(): string {
  return new Date().toLocaleDateString("en-CA"); // YYYY-MM-DD in local time
}

// Kept but demoted: glance bait, not the trajectory mechanism. Idempotent per
// date: regenerating replaces the row.
export async function generateDaily(date: string, trigger: "daily" | "manual") {
  const dir = newWorkspace("daily_writeup");
  const pendingProposals = db
    .select({ id: proposal.id })
    .from(proposal)
    .where(eq(proposal.status, "pending"))
    .all().length;
  const awaitingReview = db
    .select({ id: conversation.id })
    .from(conversation)
    .where(and(isNotNull(conversation.distilledAt), isNull(conversation.extractionsReviewedAt)))
    .all().length; // rants awaiting the read-back gate
  projectWriteup(dir, { awaitingReview, pendingProposals });

  const run = await runText("daily_writeup", dir, { trigger });
  if (run.status !== "ok" || !run.output) {
    emit("daily_writeup", null, "writeup_failed", { date, error: run.error });
    return { date, status: run.status, error: run.error };
  }

  const days = daysSinceLastVisit();
  db.insert(dailyWriteup)
    .values({
      date,
      text: run.output,
      agentRunId: run.runId,
      daysSinceLastVisitAtGeneration: days,
    })
    .onConflictDoUpdate({
      target: dailyWriteup.date,
      set: { text: run.output, agentRunId: run.runId, daysSinceLastVisitAtGeneration: days },
    })
    .run();
  emit("daily_writeup", null, "writeup_generated", { date });
  return { date, status: "ok" as const, text: run.output };
}

export function getWriteup(date: string) {
  return db.select().from(dailyWriteup).where(eq(dailyWriteup.date, date)).get() ?? null;
}

export function latestWriteup() {
  return db.select().from(dailyWriteup).orderBy(desc(dailyWriteup.date)).limit(1).get() ?? null;
}

export function listWriteups(limit = 30) {
  return db.select().from(dailyWriteup).orderBy(desc(dailyWriteup.date)).limit(limit).all();
}
