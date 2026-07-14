import { eq } from "drizzle-orm";
import { db } from "../db";
import { strikeState } from "../db/schema";
import { getConfig } from "./config";
import { emit } from "./events";
import { computeVitals, daysBetween, localDate, type Vitals } from "./vitals";

// The tripwire. Two clocks, both DERIVED live — no stored counter, so the
// count can never drift from reality and any real activity zeroes it by
// simply changing the math:
//   rant clock:  floor(days_since_last_accepted_rant / STRIKE_RANT_DAYS)
//   queue clock: 1 strike per day the engine sits empty after an experiment
//                ends with nothing queued behind it
// Strikes measure disengagement from the loop's bare minimum — never bad
// days, low output, or failed experiments. Facts, not verdicts.

export interface StrikeReport {
  total: number;
  rantStrikes: number;
  queueStrikes: number;
  paused: boolean;
  pausedUntil: string | null;
  pauseReason: string | null;
  armed: boolean;
  queueNudge: boolean; // running experiment at day ≥ nudge-day with empty queue — a heads-up, NOT a strike
  facts: {
    daysSinceLastRant: number | null;
    emptyQueueDays: number;
  };
}

export function getStrikeState() {
  const row = db.select().from(strikeState).where(eq(strikeState.id, "singleton")).get();
  if (row) return row;
  return db.insert(strikeState).values({ id: "singleton" }).returning().get();
}

export function computeStrikes(asOf: string, vitals?: Vitals): StrikeReport {
  const v = vitals ?? computeVitals(asOf);
  const state = getStrikeState();
  const paused = state.pausedUntil !== null && state.pausedUntil >= asOf;

  // Pause semantics: a pause window's days never count — both clocks measure
  // from max(signal, pause end). Renegotiation happens in daylight.
  const clockFloor = (signalDate: string | null): number => {
    if (signalDate === null) return 0; // cold start: nothing to lapse from
    const start = state.pausedUntil && state.pausedUntil > signalDate ? state.pausedUntil : signalDate;
    return Math.max(0, daysBetween(start, asOf));
  };

  const rantDays = getConfig<number>("STRIKE_RANT_DAYS");
  const quietDays = v.lastAcceptedRantAt === null ? 0 : clockFloor(localDate(v.lastAcceptedRantAt));
  const rantStrikes = paused ? 0 : Math.floor(quietDays / rantDays);

  const engineLoaded = v.experiment.running !== null || v.experiment.queueDepth > 0;
  const emptyQueueDays =
    engineLoaded || v.experiment.lastEndedAt === null ? 0 : clockFloor(localDate(v.experiment.lastEndedAt));
  const queueStrikes = paused ? 0 : emptyQueueDays;

  const nudgeDay = getConfig<number>("EXPERIMENT_QUEUE_NUDGE_DAY");
  const queueNudge =
    v.experiment.running !== null && v.experiment.running.dayN >= nudgeDay && v.experiment.queueDepth === 0;

  return {
    total: rantStrikes + queueStrikes,
    rantStrikes,
    queueStrikes,
    paused,
    pausedUntil: state.pausedUntil,
    pauseReason: state.pauseReason,
    armed: state.armed,
    queueNudge,
    facts: { daysSinceLastRant: v.daysSinceLastRant, emptyQueueDays },
  };
}

// The delivery seam: the messenger (later phase) registers a sink that
// knows how to reach the linked primary witness. No sink registered — or the
// sink finding nobody linked — means the tripwire stays dark by construction.
// The sink returns the witness id it alerted, or null if it couldn't.
type AlertSink = (body: string, report: StrikeReport) => Promise<string | null>;
let alertSink: AlertSink | null = null;
export function registerStrikeAlertSink(sink: AlertSink | null) {
  alertSink = sink;
}

// Heartbeat step: evaluate the clocks and — only when live — fire ONE alert
// per episode. Dark mode (STRIKE_ALERTS_ENABLED=false) computes and reports
// but never messages anyone and never consumes the armed flag.
export async function runStrikeCheck(asOf: string): Promise<StrikeReport & { alertFired: boolean }> {
  const report = computeStrikes(asOf);
  const threshold = getConfig<number>("STRIKE_THRESHOLD");
  let alertFired = false;

  if (report.total < threshold) {
    // Contact happened (a clock reset) — the episode is over; re-arm.
    if (!report.armed) {
      db.update(strikeState).set({ armed: true }).where(eq(strikeState.id, "singleton")).run();
      report.armed = true;
    }
    return { ...report, alertFired };
  }

  const enabled = getConfig<boolean>("STRIKE_ALERTS_ENABLED");
  if (enabled && report.armed && !report.paused && alertSink) {
    const alertedWitnessId = await alertSink(renderStrikeAlert(report), report);
    if (alertedWitnessId) {
      db.update(strikeState)
        .set({ armed: false, lastAlertAt: new Date().toISOString() })
        .where(eq(strikeState.id, "singleton"))
        .run();
      emit("strike", null, "strike_alert_fired", {
        witnessId: alertedWitnessId,
        total: report.total,
        facts: report.facts,
      });
      report.armed = false;
      alertFired = true;
    }
  }
  return { ...report, alertFired };
}

// The alert body is a deterministic template — social messages with hard
// "facts not verdicts" constraints must be predictable, never LLM output.
export function renderStrikeAlert(report: StrikeReport): string {
  const template = getConfig<string>("TEMPLATE.strike_alert");
  const facts: string[] = [];
  if (report.rantStrikes > 0 && report.facts.daysSinceLastRant !== null) {
    facts.push(`no new rants in ${report.facts.daysSinceLastRant} days`);
  }
  if (report.queueStrikes > 0) {
    facts.push(`nothing queued for ${report.facts.emptyQueueDays} day${report.facts.emptyQueueDays === 1 ? "" : "s"} since the last experiment ended`);
  }
  return template.replace("{{FACTS}}", facts.join(" and "));
}

export function pauseStrikes(days: number, reason?: string) {
  const until = new Date(Date.now() + days * 86_400_000).toLocaleDateString("en-CA");
  getStrikeState();
  db.update(strikeState)
    .set({ pausedUntil: until, pauseReason: reason ?? null })
    .where(eq(strikeState.id, "singleton"))
    .run();
  emit("strike", null, "strikes_paused", { until, reason: reason ?? null });
  return { pausedUntil: until };
}

export function resumeStrikes() {
  getStrikeState();
  db.update(strikeState)
    .set({ pausedUntil: null, pauseReason: null })
    .where(eq(strikeState.id, "singleton"))
    .run();
  emit("strike", null, "strikes_resumed", {});
}
