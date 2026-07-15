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
  //    absent. Dark until a primary witness chat is linked and alerts enabled.
  try {
    const { initMessaging } = await import("./messaging/messenger");
    initMessaging(); // idempotent: gives the tripwire its delivery sink
    const { runStrikeCheck } = await import("./strikes");
    const { todayLocal } = await import("./writeup");
    report.strikes = await runStrikeCheck(todayLocal());
  } catch (e) {
    report.strikes = { error: e instanceof Error ? e.message : String(e) };
    emit("heartbeat", null, "heartbeat_step_failed", { step: "strikes", error: String(e) });
  }

  // 2. Duty pings — visible-but-ducking staleness → factual friend lines.
  try {
    const { runDutyPings } = await import("./dutyPings");
    report.dutyPings = runDutyPings();
  } catch (e) {
    report.dutyPings = { error: e instanceof Error ? e.message : String(e) };
    emit("heartbeat", null, "heartbeat_step_failed", { step: "duty_pings", error: String(e) });
  }

  // 3. Random friend prompts (bounded) + outbox flush.
  try {
    const { scheduleWitnessPrompts, flushOutbound } = await import("./messaging/messenger");
    report.prompts = await scheduleWitnessPrompts(trigger);
    report.flush = await flushOutbound();
  } catch (e) {
    report.messaging = { error: e instanceof Error ? e.message : String(e) };
    emit("heartbeat", null, "heartbeat_step_failed", { step: "messaging", error: String(e) });
  }

  // 4. Safety-net sweep: idempotent leftovers from event-driven steps.
  //    Detection respects AUTO_DETECT — with it off (bulk-import onboarding),
  //    the heartbeat must not classify the backlog behind the user's back.
  try {
    const { getConfig } = await import("./config");
    if (getConfig<boolean>("AUTO_DETECT")) {
      const { detectPendingRants } = await import("./rantDetection");
      report.detect = await detectPendingRants(trigger);
    } else {
      report.detect = { skipped: "AUTO_DETECT off" };
    }
  } catch (e) {
    report.detect = { error: e instanceof Error ? e.message : String(e) };
    emit("heartbeat", null, "heartbeat_step_failed", { step: "detect", error: String(e) });
  }

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
