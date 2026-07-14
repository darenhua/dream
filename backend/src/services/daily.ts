import { derivePendingReviewed } from "./derive";
import { distillPending } from "./distill";
import { emit } from "./events";

// The heartbeat: one function, invoked by system cron at 09:00 ET
// (`bun run heartbeat`) and by POST /api/jobs/daily. Its real job is the work
// that CANNOT be event-driven — noticing absence. Everything else in the
// pipeline fires when new work moves along it (import → distill, confirm →
// derive, visit → writeup + calendar sync); the sweep here is only a safety
// net for fire-and-forget steps that died mid-flight.
//
// Sequential; each step try/caught and event-logged so one failure doesn't
// hide the others. No scheduled re-derives ever: distill and derive only touch
// conversations that entered the pipeline and haven't finished it.
export async function runHeartbeat(trigger: "daily" | "manual") {
  const report: Record<string, unknown> = {};

  // 1. Vitals + strike check — the tripwire that fires while the user is
  //    absent. (Filled in by the strike engine; placeholder until then.)
  // 2. Duty pings — visible-but-ducking staleness → factual friend lines.
  //    (Filled in by the outbox/messenger work.)
  // 3. Outbox flush — send approved messages past their notBefore.
  //    (Filled in with the transport.)

  // 4. Safety-net sweep: idempotent leftovers from event-driven steps.
  try {
    report.distill = await distillPending(trigger);
  } catch (e) {
    report.distill = { error: e instanceof Error ? e.message : String(e) };
    emit("heartbeat", null, "heartbeat_step_failed", { step: "distill", error: String(e) });
  }

  try {
    report.derive = await derivePendingReviewed(trigger);
  } catch (e) {
    report.derive = { error: e instanceof Error ? e.message : String(e) };
    emit("heartbeat", null, "heartbeat_step_failed", { step: "derive", error: String(e) });
  }

  try {
    report.calendar = await calendarHousekeeping();
  } catch (e) {
    report.calendar = { error: e instanceof Error ? e.message : String(e) };
    emit("heartbeat", null, "heartbeat_step_failed", { step: "calendar", error: String(e) });
  }

  emit("heartbeat", null, "heartbeat_completed", report);
  return report;
}

async function calendarHousekeeping() {
  // Lazy import: the sync module touches Google auth state; keep the heartbeat
  // loadable (and testable) without it.
  const { syncIncremental, isConnected } = await import("./calendarSync");
  if (!isConnected()) return { skipped: "google calendar not connected" };
  return syncIncremental();
}
