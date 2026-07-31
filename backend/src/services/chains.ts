import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db";
import { calendarEvent, chainRun, chainRunStep, ifThenChain, ifThenChainStep, winEntry } from "../db/schema";
import { createScheduledEvents, pushPendingEvents } from "./calendarWriter";
import { emit } from "./events";

// If-then chains (PLANNING_REVAMP_SPEC §4.1): the atomic unit of execution.
// The library belongs to an experiment group; weekly planning creates and
// re-picks chains, daily planning arms them, the now-screen walks them.
// Direct-write like daily plans — the conversation's confirmation is the
// review; nothing here passes through the change-set inbox.

// 3–5 active chains is the contract; the cap is the reason the system stays
// legible under pressure. Reject the 6th, never silently allow it.
const ACTIVE_CAP = 5;

const StepSchema = z.object({
  kind: z.enum(["starter", "warmup", "core", "reward"]),
  text: z.string().trim().min(1).max(2_000),
});

export const ChainInputSchema = z
  .object({
    experimentGroupLineageId: z.string().min(1),
    trigger: z.string().trim().min(1).max(500), // the real-world cue
    purpose: z.string().trim().max(2_000).optional(),
    description: z.string().trim().max(50_000).optional(),
    minimumVersion: z.string().trim().max(2_000).optional(),
    rewardKind: z.enum(["walk", "cold_drink", "playlist", "easy_task"]).optional(),
    rewardText: z.string().trim().max(2_000).optional(),
    expiresAt: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    status: z.enum(["draft", "active"]).default("active"),
    steps: z.array(StepSchema).min(3).max(12),
  })
  .strict();
export type ChainInput = z.infer<typeof ChainInputSchema>;

/** Canonical shape: exactly one comically-easy starter FIRST, exactly one
 * reward LAST, at least one core in between. Warmups sit between starter and
 * the first core. */
function assertCanonicalShape(steps: z.infer<typeof StepSchema>[]) {
  const starters = steps.filter(s => s.kind === "starter").length;
  const rewards = steps.filter(s => s.kind === "reward").length;
  const cores = steps.filter(s => s.kind === "core").length;
  if (starters !== 1 || steps[0]?.kind !== "starter")
    throw new Error("a chain needs exactly one starter step, and it must come first");
  if (rewards !== 1 || steps[steps.length - 1]?.kind !== "reward")
    throw new Error("a chain needs exactly one reward step, and it must come last");
  if (cores < 1) throw new Error("a chain needs at least one core step");
  const firstCore = steps.findIndex(s => s.kind === "core");
  if (steps.slice(1, firstCore).some(s => s.kind !== "warmup"))
    throw new Error("only warmup steps may sit between the starter and the first core step");
  if (steps.slice(firstCore, -1).some(s => s.kind !== "core"))
    throw new Error("warmup steps belong before the core work, not after it");
}

type ChainRow = typeof ifThenChain.$inferSelect;

/** Lineage heads of a group's library (newest version per lineage). */
function libraryHeads(groupLineageId: string): ChainRow[] {
  const rows = db
    .select()
    .from(ifThenChain)
    .where(eq(ifThenChain.experimentGroupLineageId, groupLineageId))
    .all();
  const heads = new Map<string, ChainRow>();
  for (const row of rows) {
    const key = row.lineageId ?? row.id;
    const prev = heads.get(key);
    if (!prev || (row.version ?? 1) > (prev.version ?? 1)) heads.set(key, row);
  }
  return [...heads.values()];
}

export function chainHead(lineageId: string): ChainRow | undefined {
  return db
    .select()
    .from(ifThenChain)
    .where(eq(ifThenChain.lineageId, lineageId))
    .orderBy(desc(ifThenChain.version))
    .limit(1)
    .get();
}

function chainSteps(chainVersionId: string) {
  return db
    .select()
    .from(ifThenChainStep)
    .where(eq(ifThenChainStep.chainId, chainVersionId))
    .orderBy(ifThenChainStep.position)
    .all();
}

function assertActiveCap(groupLineageId: string, excludeLineageId?: string) {
  const active = libraryHeads(groupLineageId).filter(
    h => h.status === "active" && (h.lineageId ?? h.id) !== excludeLineageId,
  );
  if (active.length >= ACTIVE_CAP)
    throw new Error(
      `the library already has ${active.length} active chains — 3–5 is the contract; retire one before activating another`,
    );
}

function insertChainVersion(
  input: ChainInput,
  lineage?: { lineageId: string; prevVersionId: string; version: number },
) {
  const id = crypto.randomUUID();
  db.insert(ifThenChain)
    .values({
      id,
      lineageId: lineage?.lineageId ?? id,
      version: lineage?.version ?? 1,
      prevVersionId: lineage?.prevVersionId ?? null,
      experimentGroupLineageId: input.experimentGroupLineageId,
      trigger: input.trigger,
      purpose: input.purpose ?? null,
      description: input.description ?? null,
      minimumVersion: input.minimumVersion ?? null,
      rewardKind: input.rewardKind ?? null,
      rewardText: input.rewardText ?? null,
      status: input.status,
      expiresAt: input.expiresAt ?? null,
    })
    .run();
  input.steps.forEach((step, position) => {
    db.insert(ifThenChainStep).values({ chainId: id, position, kind: step.kind, text: step.text }).run();
  });
  return getChainByVersionId(id)!;
}

export function getChainByVersionId(versionId: string) {
  const row = db.select().from(ifThenChain).where(eq(ifThenChain.id, versionId)).get();
  if (!row) return null;
  return { ...row, steps: chainSteps(row.id) };
}

export function createChain(raw: unknown) {
  const input = ChainInputSchema.parse(raw);
  assertCanonicalShape(input.steps);
  if (input.status === "active") assertActiveCap(input.experimentGroupLineageId);
  const chain = insertChainVersion(input);
  emit("if_then_chain", chain.id, "chain_created", { lineageId: chain.lineageId, trigger: chain.trigger });
  return chain;
}

/** Version bump: a revision supplies the complete new shape. */
export function reviseChain(lineageId: string, raw: unknown) {
  const head = chainHead(lineageId);
  if (!head) throw new Error(`no chain with lineage ${lineageId}`);
  const input = ChainInputSchema.parse(raw);
  assertCanonicalShape(input.steps);
  if (head.status !== "active" && input.status === "active")
    assertActiveCap(input.experimentGroupLineageId, lineageId);
  const chain = insertChainVersion(
    { ...input, status: input.status === "active" || head.status === "active" ? "active" : input.status },
    { lineageId, prevVersionId: head.id, version: (head.version ?? 1) + 1 },
  );
  emit("if_then_chain", chain.id, "chain_revised", { lineageId, version: chain.version });
  return chain;
}

/** Habit-precedent lifecycle: status mutates on the head row. */
export function setChainStatus(lineageId: string, status: "draft" | "active" | "retired") {
  const head = chainHead(lineageId);
  if (!head) throw new Error(`no chain with lineage ${lineageId}`);
  if (status === "active" && head.status !== "active") assertActiveCap(head.experimentGroupLineageId, lineageId);
  db.update(ifThenChain).set({ status }).where(eq(ifThenChain.id, head.id)).run();
  emit("if_then_chain", head.id, "chain_status", { lineageId, status });
  return getChainByVersionId(head.id)!;
}

export function chainLibrary(groupLineageId: string) {
  const order = { active: 0, draft: 1, retired: 2 } as const;
  return libraryHeads(groupLineageId)
    .sort((a, b) => order[a.status] - order[b.status] || (a.createdAt < b.createdAt ? -1 : 1))
    .map(head => ({ ...head, steps: chainSteps(head.id) }));
}

// ── Runs ────────────────────────────────────────────────────────────────────

export const ArmChainInputSchema = z
  .object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    dailyPlanId: z.string().optional(), // absent = ad-hoc surplus-capacity run
    startAt: z.string().datetime().optional(),
    endAt: z.string().datetime().optional(),
    dayTheme: z.string().max(300).optional(), // rides along on the calendar block
  })
  .strict();

/** Arm a chain for a day: run row + immutable step snapshot + (optionally)
 * one calendar cue block. The block is a reminder ahead of the cue and an
 * artificial deadline — never a command. */
export function armChain(chainLineageId: string, rawOpts: unknown) {
  const opts = ArmChainInputSchema.parse(rawOpts);
  const head = chainHead(chainLineageId);
  if (!head) throw new Error(`no chain with lineage ${chainLineageId}`);
  if (head.status === "retired") throw new Error(`chain "${head.trigger}" is retired — revise or re-activate it first`);

  const run = db
    .insert(chainRun)
    .values({ chainVersionId: head.id, dailyPlanId: opts.dailyPlanId ?? null, date: opts.date })
    .returning()
    .get();
  const template = chainSteps(head.id);
  for (const step of template) {
    db.insert(chainRunStep)
      .values({ chainRunId: run.id, position: step.position, kind: step.kind, text: step.text })
      .run();
  }

  let calendarEventId: string | null = null;
  if (opts.startAt && opts.endAt) {
    const starter = template.find(s => s.kind === "starter");
    const title = `when ${head.trigger} → ${starter?.text ?? "start"}${opts.dayTheme ? ` · ${opts.dayTheme}` : ""}`;
    const [id] = createScheduledEvents([
      {
        entityType: "chain_run",
        entityId: run.id,
        title,
        startAt: opts.startAt,
        endAt: opts.endAt,
        blockStyle: "chain",
      },
    ]);
    calendarEventId = id ?? null;
    db.update(chainRun).set({ calendarEventId }).where(eq(chainRun.id, run.id)).run();
    void pushPendingEvents().catch(() => {});
  }

  emit("chain_run", run.id, "chain_armed", { date: opts.date, chainLineageId, adHoc: !opts.dailyPlanId });
  return getRun(run.id)!;
}

export function getRun(runId: string) {
  const run = db.select().from(chainRun).where(eq(chainRun.id, runId)).get();
  if (!run) return null;
  const steps = db
    .select()
    .from(chainRunStep)
    .where(eq(chainRunStep.chainRunId, runId))
    .orderBy(chainRunStep.position)
    .all();
  const chain = db.select().from(ifThenChain).where(eq(ifThenChain.id, run.chainVersionId)).get();
  return { ...run, steps, chain };
}

export function runsForDate(date: string) {
  return db
    .select()
    .from(chainRun)
    .where(eq(chainRun.date, date))
    .all()
    .map(run => getRun(run.id)!);
}

function autoWinText(run: NonNullable<ReturnType<typeof getRun>>, minimum: boolean) {
  if (minimum)
    return `Minimum version — still counts: ${run.chain?.minimumVersion ?? `the "${run.chain?.trigger}" chain`}`;
  const cores = run.steps.filter(s => s.kind === "core").map(s => s.text);
  return `Ran the "${run.chain?.trigger}" chain: ${cores.join("; ")}`.slice(0, 2_000);
}

function completeRun(runId: string, minimum: boolean) {
  const now = new Date().toISOString();
  const run = getRun(runId)!;
  db.update(chainRun)
    .set({ completedAt: now, minimumOnly: minimum ? 1 : 0, startedAt: run.startedAt ?? now })
    .where(eq(chainRun.id, runId))
    .run();
  if (run.calendarEventId)
    db.update(calendarEvent).set({ completedAt: now }).where(eq(calendarEvent.id, run.calendarEventId)).run();
  db.insert(winEntry)
    .values({
      date: run.date,
      kind: "action",
      text: autoWinText(run, minimum),
      source: "auto",
      chainRunStepId: run.steps[run.steps.length - 1]?.id ?? null,
    })
    .run();
  emit("chain_run", runId, "chain_completed", { date: run.date, minimum });
}

function reopenRun(runId: string) {
  const run = getRun(runId)!;
  db.update(chainRun).set({ completedAt: null, minimumOnly: 0 }).where(eq(chainRun.id, runId)).run();
  if (run.calendarEventId)
    db.update(calendarEvent).set({ completedAt: null }).where(eq(calendarEvent.id, run.calendarEventId)).run();
  // the auto win was evidence of a completion that no longer stands
  const stepIds = run.steps.map(s => s.id);
  if (stepIds.length)
    db.delete(winEntry)
      .where(and(eq(winEntry.source, "auto"), inArray(winEntry.chainRunStepId, stepIds)))
      .run();
}

/** The now-screen tap: stamp one step, auto-derive run state + the win. */
export function toggleRunStep(runId: string, stepId: string, done: boolean) {
  const run = getRun(runId);
  if (!run) throw new Error(`no chain run ${runId}`);
  const step = run.steps.find(s => s.id === stepId);
  if (!step) throw new Error(`step ${stepId} does not belong to run ${runId}`);

  const now = new Date().toISOString();
  db.update(chainRunStep)
    .set({ doneAt: done ? now : null })
    .where(eq(chainRunStep.id, stepId))
    .run();
  if (done && !run.startedAt) db.update(chainRun).set({ startedAt: now }).where(eq(chainRun.id, runId)).run();

  const steps = db.select().from(chainRunStep).where(eq(chainRunStep.chainRunId, runId)).all();
  const allDone = steps.every(s => s.doneAt != null);
  if (allDone && !run.completedAt) completeRun(runId, false);
  if (!allDone && run.completedAt) reopenRun(runId);
  return getRun(runId)!;
}

/** The one-rep session: the minimum version completes the run and still
 * earns the win. Never a lesser state anywhere in the model. */
export function markMinimumRun(runId: string) {
  const run = getRun(runId);
  if (!run) throw new Error(`no chain run ${runId}`);
  if (run.completedAt) return run;
  completeRun(runId, true);
  return getRun(runId)!;
}

export { ACTIVE_CAP };
