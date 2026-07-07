import { desc, eq } from "drizzle-orm";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { db } from "../db";
import { dailyWriteup, proposal } from "../db/schema";
import { runText } from "./agentRunner";
import { emit } from "./events";
import {
  daysSinceLastVisit,
  newWorkspace,
  projectGlobal,
  recentEvidenceTitles,
} from "./projector";

export function todayLocal(): string {
  return new Date().toLocaleDateString("en-CA"); // YYYY-MM-DD in local time
}

// §8.7 — idempotent per date: regenerating replaces the row.
export async function generateDaily(date: string, trigger: "daily" | "manual") {
  const dir = newWorkspace("daily_writeup");
  projectGlobal(dir);

  const pendingCount = db
    .select({ id: proposal.id })
    .from(proposal)
    .where(eq(proposal.status, "pending"))
    .all().length;
  const titles = recentEvidenceTitles();
  writeFileSync(
    join(dir, "today.md"),
    `# Today (${date})\n\n` +
      `pending_proposal_count: ${pendingCount}\n\n` +
      `## New evidence since the last writeup\n\n` +
      (titles.length ? titles.map(t => `- ${t}`).join("\n") : "_(none)_") +
      "\n",
  );

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
