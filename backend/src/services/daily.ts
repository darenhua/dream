import { derivePendingReviewed } from "./derive";
import { distillPending } from "./distill";
import { emit } from "./events";
import { generateDaily, todayLocal } from "./writeup";

// The complete scheduling story: one function, invoked by system cron
// (`bun run daily`) and by POST /api/jobs/daily. Sequential; each step
// try/caught and event-logged so one failure doesn't hide the others.
//
// No scheduled re-derives ever: distill and derive only touch conversations
// that entered the pipeline and haven't finished it. Silence in = silence out.
export async function runDaily(trigger: "daily" | "manual") {
  const report: Record<string, unknown> = {};

  try {
    report.distill = await distillPending(trigger);
  } catch (e) {
    report.distill = { error: e instanceof Error ? e.message : String(e) };
    emit("daily", null, "daily_step_failed", { step: "distill", error: String(e) });
  }

  try {
    report.derive = await derivePendingReviewed(trigger);
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

  try {
    report.calendar = await calendarHousekeeping();
  } catch (e) {
    report.calendar = { error: e instanceof Error ? e.message : String(e) };
    emit("daily", null, "daily_step_failed", { step: "calendar", error: String(e) });
  }

  emit("daily", null, "daily_run_completed", report);
  return report;
}

async function calendarHousekeeping() {
  // Lazy import: the sync module touches Google auth state; keep the daily
  // job loadable (and testable) without it.
  const { syncIncremental, isConnected } = await import("./calendarSync");
  if (!isConnected()) return { skipped: "google calendar not connected" };
  return syncIncremental();
}
