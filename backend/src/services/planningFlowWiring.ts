import { mondayOf } from "../lib/time";
import { activePlanFor } from "./dailyPlanV2";
import { createDailyV3, renderDailyForPlaybook, updateDailyV3 } from "./dailyPlansV3";
import { activeEra, latestEra, monthlyById, renderMonthlyOnePager, createMonthly, updateMonthly } from "./monthlyPlans";
import {
  registerPlaybookRenderer,
  registerRevisionLookup,
  registerSaveHandler,
  type SessionRow,
} from "./planningFlows";
import type { PlanningFacts } from "./planningOracle";
import {
  latenessRead,
  pbDailyCreateV1,
  pbDailyUpdateV1,
  pbMonthlyCreateV1,
  pbMonthlyUpdateV1,
  pbWeeklyCreateV1,
  pbWeeklyUpdateV1,
} from "./playbooks";
import { recurringChainSet, renderWeeklyForPlaybook, weeklyChainsView, weeklyHeadFor, createWeeklyV3, updateWeeklyV3 } from "./weeklyPlansV3";
import { db } from "../db";
import { weeklyPlan } from "../db/schema";
import { eq } from "drizzle-orm";

// One wiring module so the flow engine, the plan services, and the oracle
// stay cycle-free: everything registers here, dreamServer imports this for
// its side effects.

// ── Revision lookups (begin: who is the current head for a target period) ──

registerRevisionLookup("monthly", targetStartDate => {
  const era = activeEra(targetStartDate) ?? activeEra();
  return era ? { planId: era.id, revision: era.revision } : null;
});

registerRevisionLookup("weekly", targetStartDate => {
  const head = weeklyHeadFor(targetStartDate);
  // Legacy v2 rows count as existing plans (update targets them too).
  return head ? { planId: head.id, revision: head.revision } : null;
});

registerRevisionLookup("daily", targetStartDate => {
  const plan = activePlanFor(targetStartDate);
  return plan ? { planId: plan.id, revision: plan.revision } : null;
});

// ── Save handlers ──────────────────────────────────────────────────────────

registerSaveHandler("monthly", "create", createMonthly);
registerSaveHandler("monthly", "update", updateMonthly);
registerSaveHandler("weekly", "create", createWeeklyV3);
registerSaveHandler("weekly", "update", updateWeeklyV3);
registerSaveHandler("daily", "create", createDailyV3);
registerSaveHandler("daily", "update", updateDailyV3);

// ── Playbook renderers ─────────────────────────────────────────────────────

function monthlyRenderedFor(facts: PlanningFacts): string {
  const era = activeEra(facts.now.date);
  if (era) return renderMonthlyOnePager(era);
  if (facts.era?.theme) return `Theme: ${facts.era.theme}${facts.era.story ? `\n\nStory:\n${facts.era.story}` : ""}`;
  return "(no era on file)";
}

registerPlaybookRenderer("monthly", "create", (facts: PlanningFacts) => {
  const past = latestEra();
  return pbMonthlyCreateV1({
    priorEraStory: past ? `"${past.title}" — ${past.story.slice(0, 600)}` : (facts.era?.story?.slice(0, 600) ?? null),
    liveStubs: null,
    tensions: null,
    latenessRead: latenessRead(facts.now.minutes),
  });
});

registerPlaybookRenderer("monthly", "update", (facts: PlanningFacts, session: SessionRow) => {
  const era = (session.targetPlanId ? monthlyById(session.targetPlanId) : null) ?? activeEra(facts.now.date);
  return pbMonthlyUpdateV1({
    existingMonthlyRendered: era ? renderMonthlyOnePager(era) : "(era not found — abort and re-run context)",
  });
});

registerPlaybookRenderer("weekly", "create", (facts: PlanningFacts) => {
  const priorChains =
    facts.weekly.priorWeekChains.length > 0
      ? facts.weekly.priorWeekChains.map(c => `"${c.trigger}" (${c.status})`).join(", ")
      : "(no prior week — first week of the era)";
  const cuePriors =
    facts.weekly.priorWeekChains.length > 0
      ? [...new Set(facts.weekly.priorWeekChains.map(c => c.trigger))].join(" · ")
      : "(none on file yet)";
  const era = activeEra(facts.now.date);
  const recurring = era ? recurringChainSet(era.id, facts.weekly.targetWeekStart) : [];
  return pbWeeklyCreateV1({
    monthlyRendered: monthlyRenderedFor(facts),
    depthInstruction:
      facts.era?.story && facts.era.story.length >= 200
        ? "monthly is rich — this can be light"
        : "monthly is thin — this conversation carries the depth; expect it to run long and that's correct",
    priorWeekChains: priorChains,
    cuePriors,
    rewardPool: "(reuse his known rewards: playlist, walk, coffee, cold drink — confirm, don't invent)",
    recurringSet: recurring.length > 0 ? `${recurring.length} chain(s) on autopilot` : "(none yet)",
    latenessRead: latenessRead(facts.now.minutes),
  });
});

registerPlaybookRenderer("weekly", "update", (facts: PlanningFacts, session: SessionRow) => {
  const row = session.targetPlanId
    ? db.select().from(weeklyPlan).where(eq(weeklyPlan.id, session.targetPlanId)).get()
    : weeklyHeadFor(session.targetStartDate);
  return pbWeeklyUpdateV1({
    existingWeeklyRendered: row ? renderWeeklyForPlaybook(row) : "(weekly not found — abort and re-run context)",
  });
});

registerPlaybookRenderer("daily", "create", (facts: PlanningFacts, session: SessionRow) => {
  const week = weeklyHeadFor(mondayOf(session.targetStartDate));
  const chains = week ? weeklyChainsView(week.id) : [];
  const byZone = (zone: string) =>
    chains
      .filter(c => c.zone === zone)
      .map(c => `${c.friendlyCueTitle ?? c.trigger} [${c.lineageId}]`)
      .join(", ") || "—";
  const era = activeEra(facts.now.date);
  const recurring = week?.monthlyPlanId ? recurringChainSet(week.monthlyPlanId, week.weekOf) : era ? [] : [];
  return pbDailyCreateV1({
    weeklyChainsByZone: `theme "${week?.theme ?? "?"}" · before: ${byZone("before_work")} · during: ${byZone("during_work")} · after: ${byZone("after_work")}`,
    priorDailySelections:
      facts.daily.priorThemes.length > 0
        ? facts.daily.priorThemes.map(p => `${p.date}: "${p.theme ?? ""}"`).join(" · ")
        : "(no prior dailies)",
    recurringSet: recurring.length > 0 ? recurring.map(id => `[${id}]`).join(", ") : "(none yet)",
    latenessRead: latenessRead(facts.now.minutes),
  });
});

registerPlaybookRenderer("daily", "update", (_facts: PlanningFacts, session: SessionRow) => {
  return pbDailyUpdateV1({
    existingDailyRendered: session.targetPlanId
      ? renderDailyForPlaybook(session.targetPlanId)
      : "(plan not found — abort and re-run context)",
  });
});
