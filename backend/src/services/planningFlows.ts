import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { calendarEvent, planningFlowSession } from "../db/schema";
import { addDaysStr, mondayOf } from "../lib/time";
import { emit } from "./events";
import {
  errConflict,
  errDuplicateRequest,
  errExpired,
  errFlowAmbiguous,
  errInvalidArtifact,
  errInvalidTransition,
  errNotConfirmed,
  NEXT_POINTERS,
  rcptSavedV1,
} from "./playbooks";
import { loadPlanningFacts, parseIntent, resolveDailyTarget, type PlanningFacts } from "./planningOracle";

// The workflow-session boundary (TARGET §4.2/§4.3, migration WO-2). begin
// resolves the confirmed intent into (planType, operation, targetPeriod) and
// mints a session; save derives everything from that session — the agent
// never chooses the operation or period at write time. Every refusal is a
// hook guardrail: validate first, write nothing, answer in the pack's §7
// voice with the legal next move.

export const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // C7: long sessions are the expectation

export type SessionRow = typeof planningFlowSession.$inferSelect;

export type FlowResult =
  | { ok: true; markdown: string; structured: Record<string, unknown> }
  | { ok: false; markdown: string };

// ── Save-handler registry (filled by monthly/weekly/daily plan services) ───

export type SaveOutcome = { planId: string; revision: number; period: string; supersededNote?: string };
export type SaveHandler = (session: SessionRow, plan: unknown) => SaveOutcome;

import { ArtifactRefusal, RevisionConflict } from "./flowErrors";
export { ArtifactRefusal, RevisionConflict };

const handlers = new Map<string, SaveHandler>();
export function registerSaveHandler(planType: string, operation: string, handler: SaveHandler) {
  handlers.set(`${planType}-${operation}`, handler);
}

// ── Playbook renderer registry (filled by the same services) ───────────────

export type PlaybookRenderer = (facts: PlanningFacts, session: SessionRow) => string;
const playbookRenderers = new Map<string, PlaybookRenderer>();
export function registerPlaybookRenderer(planType: string, operation: string, renderer: PlaybookRenderer) {
  playbookRenderers.set(`${planType}-${operation}`, renderer);
}

// ── Session mechanics ──────────────────────────────────────────────────────

function nowIso(): string {
  return new Date().toISOString();
}

export function sessionById(id: string): SessionRow | undefined {
  return db.select().from(planningFlowSession).where(eq(planningFlowSession.id, id)).get();
}

/** Lazy expiry: an active session past expiresAt flips to expired on touch. */
function expireIfStale(session: SessionRow): SessionRow {
  if (session.status === "active" && session.expiresAt < nowIso()) {
    db.update(planningFlowSession)
      .set({ status: "expired" })
      .where(eq(planningFlowSession.id, session.id))
      .run();
    return { ...session, status: "expired" };
  }
  return session;
}

/** Any session-bound activity refreshes the TTL (C7). */
function refreshTtl(sessionId: string) {
  db.update(planningFlowSession)
    .set({ expiresAt: new Date(Date.now() + SESSION_TTL_MS).toISOString() })
    .where(eq(planningFlowSession.id, sessionId))
    .run();
}

function cancelActiveSiblings(planType: "daily" | "weekly" | "monthly", targetStartDate: string) {
  db.update(planningFlowSession)
    .set({ status: "cancelled" })
    .where(
      and(
        eq(planningFlowSession.planType, planType),
        eq(planningFlowSession.targetStartDate, targetStartDate),
        eq(planningFlowSession.status, "active"),
      ),
    )
    .run();
}

/** The target period's calendar rows as DATED data for the snapshot —
 * cheap staleness mitigation (BRIEF item 59), never ground truth. */
function calendarWindow(startDate: string, endDate: string) {
  return db
    .select()
    .from(calendarEvent)
    .all()
    .filter(e => e.startAt.slice(0, 10) >= startDate && e.startAt.slice(0, 10) <= endDate)
    .slice(0, 50)
    .map(e => ({ title: e.title, startAt: e.startAt, endAt: e.endAt, status: e.status }));
}

// ── Intent resolution ──────────────────────────────────────────────────────

function wantsUpdate(text: string): boolean {
  return /\b(update|revise|revising|change|changing|add|adding|extend|extending|swap|swapping|edit|editing|tweak|rework)\b/i.test(
    text,
  );
}
function wantsCreate(text: string): boolean {
  return /\b(create|new|make|making|start|starting|build|building|fresh|plan (the|my|this|next))\b/i.test(text);
}

type ResolvedIntent = {
  planType: "daily" | "weekly" | "monthly";
  operation: "create" | "update";
  targetStartDate: string;
  targetEndDate: string | null;
  targetPlanId: string | null;
  initialPlanRevision: number | null;
};

/** Current revision lookup per plan type — filled by the plan services so
 * this module stays schema-agnostic. */
export type RevisionLookup = (targetStartDate: string) => { planId: string; revision: number } | null;
const revisionLookups = new Map<string, RevisionLookup>();
export function registerRevisionLookup(planType: string, lookup: RevisionLookup) {
  revisionLookups.set(planType, lookup);
}
function currentPlanFor(planType: string, targetStartDate: string) {
  return revisionLookups.get(planType)?.(targetStartDate) ?? null;
}

function resolveIntent(
  facts: PlanningFacts,
  confirmedIntent: string,
  targetDate?: string,
): ResolvedIntent | { ambiguity: string } | { invalid: { reason: string; recovery: string } } {
  const horizon = parseIntent(confirmedIntent);
  if (!horizon) return { ambiguity: "which horizon (daily / weekly / monthly era)" };
  const create = wantsCreate(confirmedIntent);
  const update = wantsUpdate(confirmedIntent);

  if (horizon === "monthly") {
    const eraActive = facts.era && !facts.era.expired;
    if (eraActive) {
      if (create && !update)
        return {
          ambiguity: 'update vs fresh — an era is already active; "new era" would supersede it',
        };
      const existing = currentPlanFor("monthly", facts.era!.periodStart);
      return {
        planType: "monthly",
        operation: "update",
        targetStartDate: facts.era!.periodStart,
        targetEndDate: facts.era!.periodEnd,
        targetPlanId: existing?.planId ?? null,
        initialPlanRevision: existing?.revision ?? null,
      };
    }
    // No active era → create. The era's real period is user-chosen in the
    // flow; the session anchors on today and save applies era sanity only.
    return {
      planType: "monthly",
      operation: "create",
      targetStartDate: targetDate ?? facts.now.date,
      targetEndDate: null,
      targetPlanId: null,
      initialPlanRevision: null,
    };
  }

  if (horizon === "weekly") {
    if (!facts.era || facts.era.expired)
      return {
        invalid: {
          reason: "no active era, so a weekly plan cannot exist yet",
          recovery:
            'offer the era first in one line ("We don\'t have the big picture yet — want to spend a few minutes on what this stretch is for, then do the week right after?") — a thin era (theme + story) unblocks; then begin monthly-create',
        },
      };
    const nextWeek = /\bnext week\b/i.test(confirmedIntent);
    const weekStart = targetDate ? mondayOf(targetDate) : nextWeek ? addDaysStr(facts.weekly.targetWeekStart, 7) : facts.weekly.targetWeekStart;
    const existing = currentPlanFor("weekly", weekStart);
    if (existing && create && !update)
      return { ambiguity: `update vs fresh — a plan for the week of ${weekStart} already exists` };
    return {
      planType: "weekly",
      operation: existing ? "update" : "create",
      targetStartDate: weekStart,
      targetEndDate: addDaysStr(weekStart, 6),
      targetPlanId: existing?.planId ?? null,
      initialPlanRevision: existing?.revision ?? null,
    };
  }

  // daily
  if (!facts.era || facts.era.expired)
    return {
      invalid: {
        reason: "no active era, so a daily plan cannot exist yet",
        recovery: "offer the era first — a thin era (theme + story) unblocks the week, then the day",
      },
    };
  const date =
    targetDate ??
    (/\btoday\b/i.test(confirmedIntent)
      ? facts.now.date
      : /\btomorrow\b/i.test(confirmedIntent)
        ? facts.daily.tomorrow.date
        : resolveDailyTarget(facts, "none").date);
  const weekOfDate = mondayOf(date);
  const weekPlan = currentPlanFor("weekly", weekOfDate);
  if (!weekPlan)
    return {
      invalid: {
        reason: `daily plans select from the week's chains, and no weekly exists for the week of ${weekOfDate}`,
        recovery:
          "offer the weekly first — floor is theme-only and takes five minutes; a theme-only week means tomorrow just runs existing chains",
      },
    };
  const existing = currentPlanFor("daily", date);
  if (existing && create && !update)
    return { ambiguity: `update vs fresh — a plan for ${date} already exists` };
  return {
    planType: "daily",
    operation: existing ? "update" : "create",
    targetStartDate: date,
    targetEndDate: date,
    targetPlanId: existing?.planId ?? null,
    initialPlanRevision: existing?.revision ?? null,
  };
}

// ── begin_planning_flow ────────────────────────────────────────────────────

export function beginPlanningFlow(input: {
  confirmed_intent: string;
  target_date?: string;
  target_plan_id?: string;
}): FlowResult {
  const facts = loadPlanningFacts(input.target_date);
  const resolved = resolveIntent(facts, input.confirmed_intent, input.target_date);
  if ("ambiguity" in resolved) return { ok: false, markdown: errFlowAmbiguous(resolved.ambiguity) };
  if ("invalid" in resolved)
    return { ok: false, markdown: errInvalidTransition(resolved.invalid.reason, resolved.invalid.recovery) };

  const playbookVersion = `PB.${resolved.planType}-${resolved.operation}.v1`;
  const renderer = playbookRenderers.get(`${resolved.planType}-${resolved.operation}`);
  if (!renderer)
    return {
      ok: false,
      markdown: errInvalidTransition(
        `the ${resolved.planType}-${resolved.operation} flow is not available in this build`,
        "tell the user this one needs a moment and try a different flow",
      ),
    };

  cancelActiveSiblings(resolved.planType, resolved.targetStartDate);

  const snapshot = {
    parentSubstance: {
      monthlyStory: facts.era?.story ? "present" : "absent",
      weeklyChains: facts.weekly.plan?.chainCount ?? 0,
    },
    priorWeekChains: facts.weekly.priorWeekChains,
    calendarWindow: calendarWindow(resolved.targetStartDate, resolved.targetEndDate ?? resolved.targetStartDate),
    briefing: { date: facts.now.date, time: facts.now.time },
  };

  const session = db
    .insert(planningFlowSession)
    .values({
      planType: resolved.planType,
      operation: resolved.operation,
      targetStartDate: resolved.targetStartDate,
      targetEndDate: resolved.targetEndDate,
      targetPlanId: input.target_plan_id ?? resolved.targetPlanId,
      initialPlanRevision: resolved.initialPlanRevision,
      contextSnapshotJson: JSON.stringify(snapshot),
      playbookVersion,
      expiresAt: new Date(Date.now() + SESSION_TTL_MS).toISOString(),
    })
    .returning()
    .get();

  emit("planning_flow_session", session.id, "planning_flow_begun", {
    planType: resolved.planType,
    operation: resolved.operation,
    targetStartDate: resolved.targetStartDate,
  });

  const playbook = renderer(facts, session);
  const header = `# Flow session\nid: ${session.id} · ${playbookVersion} · expires ${session.expiresAt}\n\n`;
  return {
    ok: true,
    markdown: header + playbook,
    structured: {
      session_id: session.id,
      plan_type: resolved.planType,
      operation: resolved.operation,
      target_start_date: resolved.targetStartDate,
      target_end_date: resolved.targetEndDate,
      target_plan_id: session.targetPlanId,
      playbook_version: playbookVersion,
      expires_at: session.expiresAt,
    },
  };
}

// ── save_plan ──────────────────────────────────────────────────────────────

function payloadHash(plan: unknown): string {
  return new Bun.CryptoHasher("sha256").update(JSON.stringify(plan)).digest("hex");
}

export function savePlan(input: {
  workflow_session_id: string;
  request_id: string;
  user_confirmed_save: boolean;
  plan: unknown;
}): FlowResult {
  const found = sessionById(input.workflow_session_id);
  if (!found)
    return {
      ok: false,
      markdown: errInvalidTransition(
        "no flow session with that id",
        "call get_planning_context, re-confirm the flow, and begin_planning_flow again",
      ),
    };
  const session = expireIfStale(found);
  const hash = payloadHash(input.plan);

  if (session.status === "completed") {
    // Idempotent retry: same request + same payload → the original receipt.
    if (session.requestId === input.request_id && session.payloadHash === hash && session.receiptJson) {
      const receipt = JSON.parse(session.receiptJson) as { markdown: string; structured: Record<string, unknown> };
      return { ok: true, markdown: receipt.markdown, structured: receipt.structured };
    }
    if (session.requestId === input.request_id) return { ok: false, markdown: errDuplicateRequest() };
    return {
      ok: false,
      markdown: errInvalidTransition(
        "this flow already completed with a different save",
        "begin_planning_flow again for a further change",
      ),
    };
  }
  if (session.status === "expired") return { ok: false, markdown: errExpired() };
  if (session.status === "cancelled" || session.status === "conflicted")
    return {
      ok: false,
      markdown: errInvalidTransition(
        `this flow session is ${session.status}`,
        "call get_planning_context and begin_planning_flow again — the drafted artifact carries over",
      ),
    };

  if (input.user_confirmed_save !== true) return { ok: false, markdown: errNotConfirmed() };

  const handler = handlers.get(`${session.planType}-${session.operation}`);
  if (!handler)
    return {
      ok: false,
      markdown: errInvalidTransition(
        `the ${session.planType}-${session.operation} save path is not available in this build`,
        "tell the user this one needs a moment",
      ),
    };

  refreshTtl(session.id);
  let outcome: SaveOutcome;
  try {
    outcome = handler(session, input.plan);
  } catch (error) {
    if (error instanceof RevisionConflict) {
      db.update(planningFlowSession)
        .set({ status: "conflicted" })
        .where(eq(planningFlowSession.id, session.id))
        .run();
      emit("planning_flow_session", session.id, "planning_flow_conflicted", {});
      return { ok: false, markdown: errConflict(error.expected, error.found) };
    }
    if (error instanceof ArtifactRefusal) return { ok: false, markdown: errInvalidArtifact(error.message) };
    return { ok: false, markdown: errInvalidArtifact(error instanceof Error ? error.message : "unknown validation error") };
  }

  const nextPointer = NEXT_POINTERS[`${session.planType}-${session.operation}`] ?? "nothing";
  const markdown = rcptSavedV1({
    planType: session.planType,
    period: outcome.period,
    operation: session.operation,
    supersededNote: outcome.supersededNote,
    nextPointer,
  });
  const structured = {
    saved: true,
    plan_id: outcome.planId,
    revision: outcome.revision,
    plan_type: session.planType,
    operation: session.operation,
    period: outcome.period,
    receipt_version: "RCPT.saved.v1",
  };
  db.update(planningFlowSession)
    .set({
      status: "completed",
      requestId: input.request_id,
      payloadHash: hash,
      receiptJson: JSON.stringify({ markdown, structured }),
      resultPlanId: outcome.planId,
    })
    .where(eq(planningFlowSession.id, session.id))
    .run();
  emit("planning_flow_session", session.id, "planning_flow_saved", { planId: outcome.planId });
  return { ok: true, markdown, structured };
}
