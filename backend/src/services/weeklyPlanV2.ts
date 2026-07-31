import { and, desc, eq, isNull, lte } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db";
import { groupIdea, leisureActivity, task, weeklyPlan, weeklyPlanChain } from "../db/schema";
import { dayOfWeek, todayLocal } from "../lib/time";
import { createScheduledEvents, pushPendingEvents } from "./calendarWriter";
import { ChainInputSchema, chainHead, chainLibrary, createChain, getChainByVersionId, reviseChain, setChainStatus } from "./chains";
import { emit } from "./events";
import { currentPick } from "./prioritize";
import { readRecord } from "./recordReads";
import { QUALITY_BAR } from "./rubric";
import { listWeeklyPlans } from "./weeklyPlan";
import { unreviewedDays, winsForWeek } from "./wins";

// Weekly plan v2 (PLANNING_REVAMP_SPEC §4.3): the ONE heavy thinking session.
// Direct write — the conversation's echo-back + explicit confirmation is the
// review. The week's job is to make every subsequent day cheap: chains and
// cues are built here so daily planning is selection, not creation. The
// legacy experiment-table weekly path stays readable for history; v2 never
// writes it.

const ChainSpecSchema = ChainInputSchema.omit({ experimentGroupLineageId: true });

const ChainOpSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("create"), tempId: z.string().min(1).optional(), chain: ChainSpecSchema }).strict(),
  z.object({ op: z.literal("revise"), lineageId: z.string().min(1), chain: ChainSpecSchema }).strict(),
  z.object({ op: z.literal("retire"), lineageId: z.string().min(1) }).strict(),
  z.object({ op: z.literal("activate"), lineageId: z.string().min(1) }).strict(),
]);

export const WeeklyPlanV2InputSchema = z
  .object({
    weekOf: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .refine(value => new Date(`${value}T00:00:00.000Z`).getUTCDay() === 1, "weekOf must be a Monday"),
    direction: z.string().trim().min(1).max(500), // one-sentence weekly direction
    theme: z.string().trim().min(1).max(300),
    topOutcomes: z.array(z.string().trim().min(1).max(500)).min(1).max(3),
    milestones: z.array(z.string().trim().min(1).max(500)).max(10).default([]),
    healthPriority: z.string().trim().max(500).optional(),
    socialPriority: z.string().trim().max(500).optional(),
    maintenancePriority: z.string().trim().max(500).optional(),
    fearToFace: z.string().trim().max(1_000).optional(), // ONE avoidance pattern faced this week
    failurePoints: z
      .array(z.object({ point: z.string().trim().min(1).max(500), recovery: z.string().trim().min(1).max(500) }).strict())
      .max(10)
      .default([]),
    successDefinition: z.string().trim().max(1_000).optional(),
    candidateMissions: z.array(z.string().trim().min(1).max(500)).max(20).default([]),
    // the user's reported state (capacity, fear level…) — successors read it
    description: z.string().trim().min(1).max(50_000),
    // build/prune the chain library in the same confirmed breath
    chainOps: z.array(ChainOpSchema).max(12).default([]),
    // the 3–5 armed for the week: existing lineage ids or "temp:<tempId>"
    armedChains: z.array(z.string().min(1)).min(1).max(5),
    // must-anchor blocks only; everything else stays off the calendar
    anchoredEvents: z
      .array(
        z
          .object({
            title: z.string().trim().min(1).max(300),
            startAt: z.string().datetime(),
            endAt: z.string().datetime(),
            taskLineageId: z.string().optional(),
          })
          .strict(),
      )
      .max(20)
      .default([]),
    ideasDone: z.array(z.string()).max(50).default([]), // group_idea done-marks confirmed in conversation
  })
  .strict();
export type WeeklyPlanV2Input = z.infer<typeof WeeklyPlanV2InputSchema>;

/** Direct write, all-or-nothing: plan row + chain ops + armed set + anchors. */
export function createWeeklyPlanV2(raw: unknown) {
  const input = WeeklyPlanV2InputSchema.parse(raw);
  const pick = currentPick();
  if (!pick) throw new Error("no current pick — run prioritize before planning a week");
  const duplicate = db
    .select({ id: weeklyPlan.id })
    .from(weeklyPlan)
    .where(and(eq(weeklyPlan.currentFocusId, pick.pick.id), eq(weeklyPlan.weekOf, input.weekOf)))
    .get();
  if (duplicate) throw new Error(`a weekly plan for ${input.weekOf} already exists in this pick`);

  const planId = db.transaction(() => {
    // 1. chain ops, in the order the conversation settled them
    const tempMap = new Map<string, string>(); // tempId → lineageId
    for (const op of input.chainOps) {
      if (op.op === "create") {
        const chain = createChain({ ...op.chain, experimentGroupLineageId: pick.groupLineageId });
        if (op.tempId) tempMap.set(op.tempId, chain.lineageId!);
      } else if (op.op === "revise") {
        reviseChain(op.lineageId, { ...op.chain, experimentGroupLineageId: pick.groupLineageId });
      } else if (op.op === "retire") {
        setChainStatus(op.lineageId, "retired");
      } else {
        setChainStatus(op.lineageId, "active");
      }
    }

    // 2. the plan row
    const row = db
      .insert(weeklyPlan)
      .values({
        currentFocusId: pick.pick.id,
        weekOf: input.weekOf,
        direction: input.direction,
        theme: input.theme,
        topOutcomesJson: JSON.stringify(input.topOutcomes),
        milestonesJson: JSON.stringify(input.milestones),
        healthPriority: input.healthPriority ?? null,
        socialPriority: input.socialPriority ?? null,
        maintenancePriority: input.maintenancePriority ?? null,
        fearToFace: input.fearToFace ?? null,
        failurePointsJson: JSON.stringify(input.failurePoints),
        successDefinition: input.successDefinition ?? null,
        candidateMissionsJson: JSON.stringify(input.candidateMissions),
        description: input.description,
      })
      .returning()
      .get();

    // 3. the armed set (temp refs resolve to chains created above)
    for (const ref of input.armedChains) {
      const lineageId = ref.startsWith("temp:") ? tempMap.get(ref.slice(5)) : ref;
      if (!lineageId) throw new Error(`armedChains ref ${ref} does not resolve to a chain`);
      const head = chainHead(lineageId);
      if (!head) throw new Error(`armedChains ref ${ref}: no chain with lineage ${lineageId}`);
      if (head.status === "retired") throw new Error(`cannot arm retired chain "${head.trigger}"`);
      db.insert(weeklyPlanChain).values({ weeklyPlanId: row.id, chainLineageId: lineageId }).run();
    }

    // 4. must-anchor blocks
    for (const block of input.anchoredEvents) {
      createScheduledEvents([
        {
          entityType: block.taskLineageId ? "task" : "weekly_item",
          entityId: block.taskLineageId ?? row.id,
          title: block.title,
          startAt: block.startAt,
          endAt: block.endAt,
          blockStyle: block.taskLineageId ? "task" : "obligation",
        },
      ]);
    }

    // 5. idea done-marks confirmed during the session
    const now = new Date().toISOString();
    for (const ideaLineageId of input.ideasDone) {
      db.update(groupIdea)
        .set({ doneAt: now })
        .where(and(eq(groupIdea.groupLineageId, pick.groupLineageId), eq(groupIdea.ideaLineageId, ideaLineageId)))
        .run();
    }

    return row.id;
  });

  emit("weekly_plan", planId, "weekly_plan_v2_created", { weekOf: input.weekOf });
  void pushPendingEvents().catch(() => {});
  return weeklyPlanV2View(planId)!;
}

export function weeklyPlanV2View(id: string) {
  const row = db.select().from(weeklyPlan).where(eq(weeklyPlan.id, id)).get();
  if (!row) return null;
  const chains = db
    .select()
    .from(weeklyPlanChain)
    .where(eq(weeklyPlanChain.weeklyPlanId, id))
    .all()
    .map(link => {
      const head = chainHead(link.chainLineageId);
      return head ? getChainByVersionId(head.id) : null;
    })
    .filter(Boolean);
  return {
    ...row,
    topOutcomes: row.topOutcomesJson ? (JSON.parse(row.topOutcomesJson) as string[]) : [],
    milestones: row.milestonesJson ? (JSON.parse(row.milestonesJson) as string[]) : [],
    failurePoints: row.failurePointsJson ? (JSON.parse(row.failurePointsJson) as { point: string; recovery: string }[]) : [],
    candidateMissions: row.candidateMissionsJson ? (JSON.parse(row.candidateMissionsJson) as string[]) : [],
    chains,
  };
}

export function currentWeeklyPlanV2(date?: string) {
  const forDate = date ?? todayLocal();
  const row = db
    .select()
    .from(weeklyPlan)
    .where(lte(weeklyPlan.weekOf, forDate))
    .orderBy(desc(weeklyPlan.weekOf), desc(weeklyPlan.createdAt))
    .limit(1)
    .get();
  return row ? weeklyPlanV2View(row.id) : null;
}

function mondayOf(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((dayOfWeek(dateStr) + 6) % 7));
  return d.toISOString().slice(0, 10);
}

function weeksBetween(from: string, to: string): number {
  return Math.max(0, Math.round((new Date(to).getTime() - new Date(from).getTime()) / (7 * 24 * 3600 * 1000)));
}

/** The weekly conversation's context. REVIEW FIRST: the closing week's win
 * rollup opens the session — the plan is grounded in evidence, never mood. */
export function weeklyPlanContextV2() {
  const pick = currentPick();
  if (!pick) return { error: "no current pick — run prioritize first", currentPick: null };
  const today = todayLocal();
  const closingWeek = currentWeeklyPlanV2(today);
  const priorV2 = db
    .select()
    .from(weeklyPlan)
    .where(eq(weeklyPlan.currentFocusId, pick.pick.id))
    .orderBy(desc(weeklyPlan.weekOf))
    .all()
    .map(row => weeklyPlanV2View(row.id)!);

  return {
    today,
    qualityBar: QUALITY_BAR,
    // ALWAYS handled first in conversation: harvest + celebrate, then plan.
    reviewFirst: {
      closingWeekOf: closingWeek?.weekOf ?? mondayOf(today),
      winRollup: winsForWeek(closingWeek?.weekOf ?? mondayOf(today)),
      unreviewedDays: unreviewedDays(),
    },
    pick: {
      id: pick.pick.id,
      startedAt: pick.pick.startedAt,
      endDate: pick.pick.endDate,
      reasoning: pick.pick.reasoningMd,
      weeksElapsed: weeksBetween(pick.pick.startedAt, today),
      weeksRemaining: pick.pick.endDate ? weeksBetween(today, pick.pick.endDate) : null,
    },
    group: readRecord("experiment_group", pick.groupLineageId),
    chainLibrary: chainLibrary(pick.groupLineageId),
    weeklyPlans: priorV2,
    legacyWeeklyPlans: listWeeklyPlans(pick.pick.id), // pre-revamp history, read-only
    openTasks: db
      .select()
      .from(task)
      .where(and(isNull(task.doneAt), isNull(task.droppedAt)))
      .all()
      .map(row => ({ lineageId: row.lineageId ?? row.id, title: row.title, deadlineDate: row.deadlineDate, description: row.description })),
    leisure: db
      .select()
      .from(leisureActivity)
      .all()
      .map(row => ({ lineageId: row.lineageId ?? row.id, title: row.title, description: row.description, fitsWhen: row.fitsWhen })),
    calendarNote:
      "Read the LIVE week ahead via the user's Google Calendar MCP before proposing any cue times or anchors; Dream's rows are pending write jobs, never the calendar. The gcal MCP is READ-ONLY: all calendar writes happen through Dream.",
  };
}
