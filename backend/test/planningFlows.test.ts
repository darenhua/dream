import { beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db, wipeAllTables } from "../src/db";
import { chainRun, monthlyPlan, planningFlowSession, weeklyPlan } from "../src/db/schema";
import { addDaysStr, mondayOf, todayLocal } from "../src/lib/time";
import "../src/services/planningFlowWiring";
import { beginPlanningFlow, savePlan } from "../src/services/planningFlows";
import { getPlanningContext } from "../src/services/planningOracle";
import { currentWeeklyPlanV2 } from "../src/services/weeklyPlanV2";
import { weeklyChainsView, weeklyHeadFor } from "../src/services/weeklyPlansV3";

beforeEach(() => wipeAllTables());

// WO-2..WO-5 acceptance: context → begin → save across all three horizons,
// plus the refusal matrix (conflict, lossless expiry, idempotent retry,
// changed-payload rejection, promise subtraction, zone caps, selection
// validity, absent-parent refusals).

const TODAY = todayLocal();
const WEEK = mondayOf(TODAY);
const MIDWEEK = addDaysStr(WEEK, 2); // a Wednesday inside the planned week

function monthlyArtifact(overrides: Record<string, unknown> = {}) {
  return {
    title: "Ten weeks of audacity",
    periodStart: TODAY,
    periodEnd: addDaysStr(TODAY, 70),
    theme: "Hunger, intelligence, ambition — audacity, skill, talent.",
    story: "New city, nobody knows me. ".repeat(12).trim(),
    promises: [
      {
        kind: "habit",
        title: "Ship one public thing a week",
        doneDefinition: "To a human who isn't me and isn't an AI.",
        floorOrCadence: "Floor is 1/week, never rises",
        provenance: "this-session",
      },
    ],
    ...overrides,
  };
}

function chain(zone: string, n: number, extra: Record<string, unknown> = {}) {
  return {
    cueText: `cue ${zone} ${n}`,
    friendlyCueTitle: `Do the thing ${n}!`,
    zone,
    links: ["absurdly small step", "the real rep"],
    reward: "put on a playlist",
    kind: "habit",
    carryover: "new",
    ...extra,
  };
}

function weeklyArtifact(overrides: Record<string, unknown> = {}) {
  return {
    weekStart: WEEK,
    weekEnd: addDaysStr(WEEK, 6),
    theme: "Take up space and have audacity.",
    chains: [chain("before_work", 1), chain("during_work", 2), chain("after_work", 3)],
    leisurePool: ["walk", "cafe"],
    datedEvents: [{ date: addDaysStr(WEEK, 3), title: "Columbia in Tech" }],
    bigReward: { description: "audio interface", milestone: "the lease is signed" },
    doOnce: ["send Michael the meeting invite"],
    ...overrides,
  };
}

function begin(intent: string, targetDate?: string) {
  return beginPlanningFlow({ confirmed_intent: intent, target_date: targetDate });
}

function save(sessionId: string, plan: unknown, requestId = crypto.randomUUID(), confirmed = true) {
  return savePlan({ workflow_session_id: sessionId, request_id: requestId, user_confirmed_save: confirmed, plan });
}

function sid(result: ReturnType<typeof beginPlanningFlow>): string {
  if (!result.ok) throw new Error(`begin failed: ${result.markdown}`);
  return result.structured.session_id as string;
}

function bootstrapEra() {
  const flow = begin("create the monthly era");
  const result = save(sid(flow), monthlyArtifact());
  if (!result.ok) throw new Error(result.markdown);
  return result.structured.plan_id as string;
}

function bootstrapWeek() {
  const flow = begin("plan the week");
  const result = save(sid(flow), weeklyArtifact());
  if (!result.ok) throw new Error(result.markdown);
  return result.structured.plan_id as string;
}

describe("the 3-call trajectory: context → begin → save", () => {
  test("monthly → weekly → daily end-to-end on the new schemas", () => {
    // 1. Oracle routes to monthly-create on an empty DB.
    const ctx1 = getPlanningContext({});
    expect((ctx1.structured.candidates as { horizon: string }[])[0]!.horizon).toBe("monthly");

    // 2. Monthly: begin returns the PB.monthly-create playbook.
    const mFlow = begin("create the monthly era");
    expect(mFlow.ok).toBe(true);
    if (!mFlow.ok) throw new Error("unreachable");
    expect(mFlow.markdown).toContain("# Active flow: create the era plan");
    expect(mFlow.markdown).toContain("## Tone: ADHD-shaped conversation");
    expect(mFlow.markdown).toContain("{{era_title}}"); // ECHO.monthly template embedded
    const mSave = save(sid(mFlow), monthlyArtifact());
    expect(mSave.ok).toBe(true);
    if (!mSave.ok) throw new Error("unreachable");
    expect(mSave.markdown).toContain("# Saved");
    expect(mSave.markdown).toContain("Say ONE warm line");

    // 3. Oracle now sees the era; weekly is the likely flow.
    const ctx2 = getPlanningContext({});
    expect(ctx2.markdown).toContain('Era "Hunger, intelligence, ambition — audacity, skill, talent."');
    expect((ctx2.structured.candidates as { horizon: string }[])[0]!.horizon).toBe("weekly");

    // 4. Weekly: playbook carries the W44 one-shot verbatim; save materializes chains.
    const wFlow = begin("plan the week");
    if (!wFlow.ok) throw new Error(wFlow.markdown);
    expect(wFlow.markdown).toContain("WHEN I FINISH BRUSHING MY TEETH"); // W44 one-shot
    expect(wFlow.markdown).toContain("CARRYOVER");
    const wSave = save(sid(wFlow), weeklyArtifact());
    expect(wSave.ok).toBe(true);
    const week = weeklyHeadFor(WEEK)!;
    const menu = weeklyChainsView(week.id);
    expect(menu).toHaveLength(3);
    expect(menu.every(c => c.zone)).toBe(true);

    // 5. Daily: selection from the weekly menu, runs armed.
    const dFlow = begin("make the daily plan", MIDWEEK);
    if (!dFlow.ok) throw new Error(dFlow.markdown);
    expect(dFlow.markdown).toContain("# Active flow: tomorrow's plan");
    const dSave = save(sid(dFlow), {
      date: MIDWEEK,
      theme: "ship the want",
      selectedChainIds: [menu[0]!.lineageId, menu[1]!.lineageId],
    });
    expect(dSave.ok).toBe(true);
    expect(db.select().from(chainRun).all()).toHaveLength(2);
  });

  test("weekly/daily refuse forward when no era exists", () => {
    const w = begin("plan the week");
    expect(w.ok).toBe(false);
    if (w.ok) throw new Error("unreachable");
    expect(w.markdown).toContain("# Invalid");
    expect(w.markdown).toContain("no active era");
    const d = begin("make the daily plan", MIDWEEK);
    expect(d.ok).toBe(false);
  });

  test("daily refuses forward when the week is unplanned", () => {
    bootstrapEra();
    const d = begin("make the daily plan", MIDWEEK);
    expect(d.ok).toBe(false);
    if (d.ok) throw new Error("unreachable");
    expect(d.markdown).toContain("no weekly exists");
  });

  test("ambiguous horizon returns the one-question refusal", () => {
    const r = begin("let's do some planning");
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.markdown).toContain("# Can't start yet");
    expect(r.markdown).toContain("Ask ONE question");
  });
});

describe("save_plan boundary", () => {
  test("user_confirmed_save must be literally true", () => {
    bootstrapEra();
    const flow = begin("plan the week");
    const r = save(sid(flow), weeklyArtifact(), crypto.randomUUID(), false);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.markdown).toContain("# No approval on record");
  });

  test("idempotent retry returns the cached receipt; changed payload rejects", () => {
    bootstrapEra();
    const flow = begin("plan the week");
    const requestId = crypto.randomUUID();
    const first = save(sid(flow), weeklyArtifact(), requestId);
    expect(first.ok).toBe(true);
    const retry = save(sid(flow), weeklyArtifact(), requestId);
    expect(retry.ok).toBe(true);
    if (!first.ok || !retry.ok) throw new Error("unreachable");
    expect(retry.structured.plan_id).toBe(first.structured.plan_id);
    expect(db.select().from(weeklyPlan).all()).toHaveLength(1); // no double write

    const changed = save(sid(flow), weeklyArtifact({ theme: "different now" }), requestId);
    expect(changed.ok).toBe(false);
    if (changed.ok) throw new Error("unreachable");
    expect(changed.markdown).toContain("request_id reused with different content");
  });

  test("revision conflict: the plan moved under the flow → conflicted, no write", () => {
    bootstrapEra();
    // Session A opens against revision 1 of the era.
    const a = begin("add a promise to the era");
    // Session B (auto-cancels A? different targetStartDate same — sibling cancel!)…
    // Sibling auto-cancel applies to (planType, targetStartDate); to test the
    // conflict path, save B first, then force A back to active with its
    // original baseline.
    const aId = sid(a);
    const b = begin("add a promise to the era");
    const era = monthlyArtifact();
    const grown = {
      ...era,
      promises: [
        ...structuredClone(era.promises).map((p: Record<string, unknown>) => ({
          ...p,
          id: existingPromiseId(),
        })),
        {
          kind: "event",
          title: "First set",
          date: addDaysStr(TODAY, 30),
          doneDefinition: "Played it live.",
          provenance: "this-session",
        },
      ],
    };
    const bSave = save(sid(b), grown);
    expect(bSave.ok).toBe(true); // era now at revision 2

    db.update(planningFlowSession).set({ status: "active" }).where(eq(planningFlowSession.id, aId)).run();
    const aSave = save(aId, grown);
    expect(aSave.ok).toBe(false);
    if (aSave.ok) throw new Error("unreachable");
    expect(aSave.markdown).toContain("# Plan changed since this conversation began");
    const session = db.select().from(planningFlowSession).where(eq(planningFlowSession.id, aId)).get()!;
    expect(session.status).toBe("conflicted");
  });

  test("expiry is lossless: refusal instructs re-begin, same artifact then saves", () => {
    bootstrapEra();
    const flow = begin("plan the week");
    const id = sid(flow);
    db.update(planningFlowSession)
      .set({ expiresAt: new Date(Date.now() - 1000).toISOString() })
      .where(eq(planningFlowSession.id, id))
      .run();
    const stale = save(id, weeklyArtifact());
    expect(stale.ok).toBe(false);
    if (stale.ok) throw new Error("unreachable");
    expect(stale.markdown).toContain("# Session too old to commit");
    expect(stale.markdown).toContain("still good");
    // Re-begin, save the SAME artifact — no re-interview.
    const fresh = begin("plan the week");
    const saved = save(sid(fresh), weeklyArtifact());
    expect(saved.ok).toBe(true);
  });

  test("beginning a sibling auto-cancels the stale active session", () => {
    bootstrapEra();
    const first = begin("plan the week");
    const firstId = sid(first);
    const second = begin("plan the week");
    expect(second.ok).toBe(true);
    const row = db.select().from(planningFlowSession).where(eq(planningFlowSession.id, firstId)).get()!;
    expect(row.status).toBe("cancelled");
  });
});

function existingPromiseId(): string {
  const era = db.select().from(monthlyPlan).all()[0]!;
  return (JSON.parse(era.promisesJson) as { id: string }[])[0]!.id;
}

describe("domain invariants at the write boundary", () => {
  test("monthly-update: promise subtraction is rejected as a walk-back", () => {
    bootstrapEra();
    const flow = begin("revise the era");
    const r = save(sid(flow), monthlyArtifact({ promises: [] }));
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.markdown).toContain("promise removed");
    expect(r.markdown).toContain("append/revise-only");
  });

  test("weekly: a 4th chain in one zone surfaces the conflict, saves nothing", () => {
    bootstrapEra();
    const flow = begin("plan the week");
    const overloaded = weeklyArtifact({
      chains: [chain("before_work", 1), chain("before_work", 2), chain("before_work", 3), chain("before_work", 4)],
    });
    const r = save(sid(flow), overloaded);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.markdown).toContain("zone over 3 chains");
    expect(db.select().from(weeklyPlan).all()).toHaveLength(0);
  });

  test("weekly: theme-only week (zero chains) is legal — the floor", () => {
    bootstrapEra();
    const flow = begin("plan the week");
    const r = save(sid(flow), weeklyArtifact({ chains: [], datedEvents: [], bigReward: undefined, doOnce: [] }));
    expect(r.ok).toBe(true);
  });

  test("daily: selecting a chain outside the weekly menu is rejected", () => {
    bootstrapEra();
    bootstrapWeek();
    const flow = begin("make the daily plan", MIDWEEK);
    const r = save(sid(flow), { date: MIDWEEK, theme: "x", selectedChainIds: ["ghost-lineage"] });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.markdown).toContain("not in the current weekly plan");
  });

  test("daily: date outside the flow's period is rejected", () => {
    bootstrapEra();
    bootstrapWeek();
    const flow = begin("make the daily plan", MIDWEEK);
    const r = save(sid(flow), { date: addDaysStr(MIDWEEK, 1), theme: "x", selectedChainIds: [] });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.markdown).toContain("outside this flow's period");
  });

  test("daily update supersedes: zero-progress runs cancel, plan history survives", () => {
    bootstrapEra();
    bootstrapWeek();
    const menu = weeklyChainsView(weeklyHeadFor(WEEK)!.id);
    const first = save(sid(begin("make the daily plan", MIDWEEK)), {
      date: MIDWEEK,
      theme: "ship the want",
      selectedChainIds: [menu[0]!.lineageId],
    });
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error("unreachable");
    const updated = save(sid(begin("revise the daily plan", MIDWEEK)), {
      date: MIDWEEK,
      theme: "sharper",
      selectedChainIds: [menu[1]!.lineageId],
    });
    expect(updated.ok).toBe(true);
    const runs = db.select().from(chainRun).all();
    expect(runs.filter(r => r.cancelledAt != null)).toHaveLength(1); // old, unstarted
    expect(runs.filter(r => r.cancelledAt == null)).toHaveLength(1); // new
  });

  test("currentWeeklyPlanV2 stays exact-week after consolidation", () => {
    bootstrapEra();
    bootstrapWeek();
    expect(currentWeeklyPlanV2(MIDWEEK)?.weekOf).toBe(WEEK);
    expect(currentWeeklyPlanV2(addDaysStr(WEEK, 7))).toBeNull(); // next week: no plan is the fact
  });

  test("weekly update supersedes: old row survives, head bumps revision", () => {
    bootstrapEra();
    const firstId = bootstrapWeek();
    const flow = begin("revise the week");
    const r = save(sid(flow), weeklyArtifact({ theme: "sharper theme" }));
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    const rows = db.select().from(weeklyPlan).all();
    expect(rows).toHaveLength(2);
    const old = rows.find(row => row.id === firstId)!;
    expect(old.supersededByPlanId).toBe(r.structured.plan_id as string);
    expect(weeklyHeadFor(WEEK)!.revision).toBe(2);
  });
});
