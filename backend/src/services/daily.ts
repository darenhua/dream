import { processPendingCategorizations } from "./categorize";
import { deriveAll } from "./derive";
import { emit } from "./events";
import { generateDaily, todayLocal } from "./writeup";

// §8.9 — the complete scheduling story (N5): one function, invoked by system
// cron (`bun run daily`) and by POST /api/jobs/daily. Sequential; each step
// try/caught and event-logged so one failure doesn't hide the others.
export async function runDaily(trigger: "daily" | "manual") {
  const report: Record<string, unknown> = {};

  try {
    report.categorize = await processPendingCategorizations(trigger);
  } catch (e) {
    report.categorize = { error: e instanceof Error ? e.message : String(e) };
    emit("daily", null, "daily_step_failed", { step: "categorize", error: String(e) });
  }

  try {
    report.derive = await deriveAll(trigger);
  } catch (e) {
    report.derive = { error: e instanceof Error ? e.message : String(e) };
    emit("daily", null, "daily_step_failed", { step: "derive", error: String(e) });
  }

  try {
    report.writeup = await generateDaily(todayLocal(), trigger);
  } catch (e) {
    report.writeup = { error: e instanceof Error ? e.message : String(e) };
    emit("daily", null, "daily_step_failed", { step: "writeup", error: String(e) });
  }

  emit("daily", null, "daily_run_completed", report);
  return report;
}
