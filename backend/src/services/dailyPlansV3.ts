import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db";
import { dailyPlan } from "../db/schema";
import { mondayOf } from "../lib/time";
import { armChain, cancelUnstartedRuns, chainHead } from "./chains";
import { emit } from "./events";
import { ArtifactRefusal, RevisionConflict } from "./flowErrors";
import { activePlanFor, getDailyPlanV2 } from "./dailyPlanV2";
import type { SaveOutcome, SessionRow } from "./planningFlows";
import { recurringChainSet, weeklyChainsView, weeklyHeadFor } from "./weeklyPlansV3";

// The minimal daily (WO-5, rulings R2/R3): date + theme + which chains fire.
// Nothing else exists at this horizon — no priorities, no dominoes, no
// minimum-viable anything ("doing all my decided-on chains IS the viable
// day"). Selection validity: every chain id must live in the current
// weekly's chain set or the maturing recurring set; ≤3 per zone. Arming
// reuses the run machinery unchanged (GCal behavior per R5).

export const DailyPlanArtifactSchema = z
  .object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    theme: z.string().trim().min(1).max(300),
    selectedChainIds: z.array(z.string().min(1)).max(9).default([]),
    sourceConversationId: z.string().optional(),
  })
  .strict();
export type DailyPlanArtifact = z.infer<typeof DailyPlanArtifactSchema>;

function parseArtifact(plan: unknown): DailyPlanArtifact {
  const parsed = DailyPlanArtifactSchema.safeParse(plan);
  if (!parsed.success)
    throw new ArtifactRefusal(parsed.error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join("; "));
  return parsed.data;
}

/** Selection validity + per-zone ≤3, against the week's menu + recurring set. */
function assertSelection(artifact: DailyPlanArtifact, session: SessionRow) {
  if (artifact.date !== session.targetStartDate)
    throw new ArtifactRefusal(
      `date ${artifact.date} is outside this flow's period (${session.targetStartDate}) — date outside the flow's period`,
    );
  const week = weeklyHeadFor(mondayOf(artifact.date));
  if (!week) throw new ArtifactRefusal("no weekly plan for this date's week — the weekly comes first");
  const menu = new Set(weeklyChainsView(week.id).map(c => c.lineageId));
  const recurring = new Set(week.monthlyPlanId ? recurringChainSet(week.monthlyPlanId, week.weekOf) : []);
  const zoneCounts: Record<string, number> = {};
  for (const id of artifact.selectedChainIds) {
    if (!menu.has(id) && !recurring.has(id))
      throw new ArtifactRefusal(
        `selected chain ${id} is not in the current weekly plan or the recurring set — dailies select, they never invent`,
      );
    const head = chainHead(id);
    if (!head) throw new ArtifactRefusal(`selected chain ${id} does not exist`);
    if (head.status === "retired") throw new ArtifactRefusal(`selected chain "${head.trigger}" is retired`);
    const zone = head.zone ?? "during_work";
    zoneCounts[zone] = (zoneCounts[zone] ?? 0) + 1;
    if (zoneCounts[zone]! > 3)
      throw new ArtifactRefusal(
        `zone over 3 chains: ${zone} — surface the conflict to the user and trim; drop nothing silently`,
      );
  }
  return week;
}

export function createDailyV3(session: SessionRow, plan: unknown): SaveOutcome {
  const artifact = parseArtifact(plan);
  const week = assertSelection(artifact, session);
  if (activePlanFor(artifact.date))
    throw new ArtifactRefusal(`a plan for ${artifact.date} already exists — this flow should have been an update`);

  const planId = db.transaction(() => {
    const row = db
      .insert(dailyPlan)
      .values({
        weeklyPlanId: week.id,
        date: artifact.date,
        theme: artifact.theme,
        sourceConversationId: artifact.sourceConversationId ?? null,
      })
      .returning()
      .get();
    for (const chainLineageId of artifact.selectedChainIds) {
      armChain(chainLineageId, { date: artifact.date, dailyPlanId: row.id, dayTheme: artifact.theme });
    }
    return row.id;
  });
  emit("daily_plan", planId, "daily_plan_v3_created", { date: artifact.date });
  return { planId, revision: 1, period: artifact.date };
}

/** Update = supersede (v2 semantics kept): old row survives, zero-progress
 * runs cancel, anything started is evidence and stays. */
export function updateDailyV3(session: SessionRow, plan: unknown): SaveOutcome {
  const artifact = parseArtifact(plan);
  const week = assertSelection(artifact, session);
  const existing = session.targetPlanId
    ? db.select().from(dailyPlan).where(eq(dailyPlan.id, session.targetPlanId)).get()
    : activePlanFor(artifact.date);
  if (!existing) throw new ArtifactRefusal("no plan to update for this date — this flow should have been a create");
  if (session.initialPlanRevision != null && existing.revision !== session.initialPlanRevision)
    throw new RevisionConflict(session.initialPlanRevision, existing.revision);

  const planId = db.transaction(() => {
    const row = db
      .insert(dailyPlan)
      .values({
        weeklyPlanId: week.id,
        date: artifact.date,
        theme: artifact.theme,
        revision: existing.revision + 1,
        sourceConversationId: artifact.sourceConversationId ?? null,
      })
      .returning()
      .get();
    db.update(dailyPlan).set({ supersededByPlanId: row.id }).where(eq(dailyPlan.id, existing.id)).run();
    cancelUnstartedRuns(existing.id);
    for (const chainLineageId of artifact.selectedChainIds) {
      armChain(chainLineageId, { date: artifact.date, dailyPlanId: row.id, dayTheme: artifact.theme });
    }
    return row.id;
  });
  emit("daily_plan", planId, "daily_plan_v3_superseded", { date: artifact.date, supersededPlanId: existing.id });
  return {
    planId,
    revision: existing.revision + 1,
    period: artifact.date,
    supersededNote: "The earlier version survives as history; runs with progress kept.",
  };
}

/** Compact current-state render for the daily-update playbook. */
export function renderDailyForPlaybook(planId: string): string {
  const view = getDailyPlanV2(planId);
  if (!view) return "(plan not found)";
  const chains = view.runs.map(r => r.chain?.friendlyCueTitle ?? r.chain?.trigger ?? "?");
  return [`# ${view.date}`, `**Theme:** ${view.theme ?? "(none)"}`, `**Chains:** ${chains.join(", ") || "(none)"}`].join(
    "\n",
  );
}
