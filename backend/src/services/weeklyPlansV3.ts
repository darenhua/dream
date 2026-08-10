import { desc, eq, isNull } from "drizzle-orm";
import { and } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db";
import { weeklyPlan, weeklyPlanChain } from "../db/schema";
import { addDaysStr, dayOfWeek } from "../lib/time";
import { chainHead, createEraChain, getChainByVersionId, reviseEraChain, type EraChainSpec } from "./chains";
import { emit } from "./events";
import { ArtifactRefusal, RevisionConflict } from "./flowErrors";
import { activeEra } from "./monthlyPlans";
import type { SaveOutcome, SessionRow } from "./planningFlows";

// Weekly on chains (WO-4, TARGET §8 WeeklyPlan): theme + cue-anchored chains
// in three zones + leisure pool + dated events + big reward + do-once. The
// chain library survives (runs/NowBoard/GCal untouched) but the weekly
// artifact is the chain-first shape; a theme-only week with zero chains is
// legal (the floor). Per-zone ≤3 replaces every global armed cap (C9) — an
// overflow surfaces to the user, never a silent drop. Updates supersede:
// the old row survives, daily pointers stay on it, the library is untouched.

const ZONES = ["before_work", "during_work", "after_work"] as const;

export const WeeklyChainSchema = z
  .object({
    lineageId: z.string().min(1).optional(), // an existing chain being carried
    cueText: z.string().trim().min(1).max(300), // concrete event, never a time/feeling (coached, presence validated)
    friendlyCueTitle: z.string().trim().min(1).max(100),
    zone: z.enum(ZONES),
    links: z.array(z.string().trim().min(1).max(120)).min(1).max(4),
    reward: z.string().trim().min(1).max(300),
    kind: z.enum(["habit", "one_off"]),
    carryover: z.enum(["new", "extended", "continued"]),
    sharedCueWith: z.string().trim().max(300).optional(),
  })
  .strict();

export const WeeklyPlanArtifactSchema = z
  .object({
    weekStart: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .refine(v => dayOfWeek(v) === 1, "weekStart must be a Monday"),
    weekEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    theme: z.string().trim().min(1).max(500), // REQUIRED — theme-only is the floor
    chains: z.array(WeeklyChainSchema).max(9).default([]),
    leisurePool: z.array(z.string().trim().min(1).max(200)).max(20).default([]),
    datedEvents: z
      .array(z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), title: z.string().trim().min(1).max(300) }).strict())
      .max(20)
      .default([]),
    bigReward: z
      .object({ description: z.string().trim().min(1).max(300), milestone: z.string().trim().min(1).max(300) })
      .strict()
      .optional(),
    doOnce: z.array(z.string().trim().min(1).max(300)).max(20).default([]),
    sourceConversationId: z.string().optional(),
  })
  .strict();
export type WeeklyPlanArtifact = z.infer<typeof WeeklyPlanArtifactSchema>;

type WeeklyRow = typeof weeklyPlan.$inferSelect;

/** The HEAD (non-superseded) weekly row for a week. */
export function weeklyHeadFor(weekOf: string): WeeklyRow | null {
  return (
    db
      .select()
      .from(weeklyPlan)
      .where(and(eq(weeklyPlan.weekOf, weekOf), isNull(weeklyPlan.supersededByPlanId)))
      .orderBy(desc(weeklyPlan.createdAt))
      .limit(1)
      .get() ?? null
  );
}

export function weeklyChainRows(weeklyPlanId: string) {
  return db.select().from(weeklyPlanChain).where(eq(weeklyPlanChain.weeklyPlanId, weeklyPlanId)).all();
}

function parseArtifact(plan: unknown): WeeklyPlanArtifact {
  const parsed = WeeklyPlanArtifactSchema.safeParse(plan);
  if (!parsed.success)
    throw new ArtifactRefusal(parsed.error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join("; "));
  return parsed.data;
}

function assertInvariants(artifact: WeeklyPlanArtifact, session: SessionRow) {
  if (artifact.weekStart !== session.targetStartDate)
    throw new ArtifactRefusal(
      `weekStart ${artifact.weekStart} is outside this flow's period (${session.targetStartDate}) — date outside the flow's period`,
    );
  if (artifact.weekEnd !== addDaysStr(artifact.weekStart, 6))
    throw new ArtifactRefusal("weekEnd must be the Sunday of the same week (weekStart + 6 days)");
  for (const zone of ZONES) {
    const inZone = artifact.chains.filter(c => c.zone === zone);
    if (inZone.length > 3)
      throw new ArtifactRefusal(
        `zone over 3 chains: ${zone} has ${inZone.length} (${inZone.map(c => `"${c.friendlyCueTitle}"`).join(", ")}) — surface the conflict to the user and reshape; drop nothing silently`,
      );
  }
}

/** Create/revise the era chains an artifact carries; returns join-row specs. */
function materializeChains(monthlyPlanId: string, artifact: WeeklyPlanArtifact) {
  return artifact.chains.map(chain => {
    const spec: EraChainSpec = {
      cueText: chain.cueText,
      friendlyCueTitle: chain.friendlyCueTitle,
      zone: chain.zone,
      links: chain.links,
      reward: chain.reward,
      kind: chain.kind,
    };
    if (chain.lineageId) {
      const head = chainHead(chain.lineageId);
      if (!head) throw new ArtifactRefusal(`chain lineage ${chain.lineageId} does not exist`);
      const currentLinks = (getChainByVersionId(head.id)?.steps ?? [])
        .filter(s => s.kind !== "reward")
        .map(s => s.text);
      const changed =
        head.trigger !== chain.cueText ||
        head.friendlyCueTitle !== chain.friendlyCueTitle ||
        head.zone !== chain.zone ||
        head.rewardText !== chain.reward ||
        head.kind !== chain.kind ||
        JSON.stringify(currentLinks) !== JSON.stringify(chain.links);
      const revised = changed ? reviseEraChain(chain.lineageId, spec) : null;
      return { lineageId: chain.lineageId, carryover: chain.carryover, revisedId: revised?.id ?? head.id };
    }
    const created = createEraChain(monthlyPlanId, spec);
    return { lineageId: created.lineageId!, carryover: chain.carryover, revisedId: created.id };
  });
}

function insertWeeklyRow(args: {
  artifact: WeeklyPlanArtifact;
  monthlyPlanId: string;
  currentFocusId: string | null;
  revision: number;
}): WeeklyRow {
  const { artifact } = args;
  return db
    .insert(weeklyPlan)
    .values({
      currentFocusId: args.currentFocusId, // null on era rows — pick is sunset
      monthlyPlanId: args.monthlyPlanId,
      weekOf: artifact.weekStart,
      theme: artifact.theme,
      leisurePoolJson: JSON.stringify(artifact.leisurePool),
      datedEventsJson: JSON.stringify(artifact.datedEvents),
      bigRewardJson: artifact.bigReward ? JSON.stringify(artifact.bigReward) : null,
      doOnceJson: JSON.stringify(artifact.doOnce),
      description: null,
      revision: args.revision,
      sourceConversationId: artifact.sourceConversationId ?? null,
    })
    .returning()
    .get();
}

function linkChains(weeklyPlanId: string, links: { lineageId: string; carryover: string }[]) {
  for (const link of links) {
    db.insert(weeklyPlanChain)
      .values({ weeklyPlanId, chainLineageId: link.lineageId, carryover: link.carryover as "new" | "extended" | "continued" })
      .run();
  }
}

export function createWeeklyV3(session: SessionRow, plan: unknown): SaveOutcome {
  const artifact = parseArtifact(plan);
  // An era that begins mid-week still owns that week: resolve against both ends.
  const era = activeEra(artifact.weekStart) ?? activeEra(artifact.weekEnd);
  if (!era) throw new ArtifactRefusal("no active era for this week — the monthly comes first");
  assertInvariants(artifact, session);
  if (weeklyHeadFor(artifact.weekStart))
    throw new ArtifactRefusal(
      `a weekly plan for ${artifact.weekStart} already exists — this flow should have been an update`,
    );

  const row = db.transaction(() => {
    const links = materializeChains(era.id, artifact);
    const inserted = insertWeeklyRow({ artifact, monthlyPlanId: era.id, currentFocusId: null, revision: 1 });
    linkChains(inserted.id, links);
    return inserted;
  });
  emit("weekly_plan", row.id, "weekly_plan_v3_created", { weekOf: artifact.weekStart });
  return { planId: row.id, revision: 1, period: `week of ${artifact.weekStart}` };
}

/** Update = supersede: a NEW row wins, the old row and its chain links
 * survive as evidence, daily plans keep their pointers to the old row.
 * Retiring a chain mid-week is legal — runs are snapshots. */
export function updateWeeklyV3(session: SessionRow, plan: unknown): SaveOutcome {
  const artifact = parseArtifact(plan);
  const target = session.targetPlanId
    ? db.select().from(weeklyPlan).where(eq(weeklyPlan.id, session.targetPlanId)).get()
    : weeklyHeadFor(session.targetStartDate);
  if (!target) throw new ArtifactRefusal("no weekly plan to update — this flow should have been a create");
  if (session.initialPlanRevision != null && target.revision !== session.initialPlanRevision)
    throw new RevisionConflict(session.initialPlanRevision, target.revision);
  // An era that begins mid-week still owns that week: resolve against both ends.
  const era = activeEra(artifact.weekStart) ?? activeEra(artifact.weekEnd);
  if (!era) throw new ArtifactRefusal("no active era for this week — the monthly comes first");
  assertInvariants(artifact, session);

  const row = db.transaction(() => {
    const links = materializeChains(era.id, artifact);
    const inserted = insertWeeklyRow({
      artifact,
      monthlyPlanId: era.id,
      currentFocusId: target.currentFocusId,
      revision: target.revision + 1,
    });
    linkChains(inserted.id, links);
    db.update(weeklyPlan).set({ supersededByPlanId: inserted.id }).where(eq(weeklyPlan.id, target.id)).run();
    return inserted;
  });
  emit("weekly_plan", row.id, "weekly_plan_v3_superseded", { weekOf: artifact.weekStart, supersededPlanId: target.id });
  return {
    planId: row.id,
    revision: row.revision,
    period: `week of ${artifact.weekStart}`,
    supersededNote: "Previous version of the week survives as history; today's armed runs are unaffected.",
  };
}

/** The week's chains with heads — echo-context render + daily's menu. */
export function weeklyChainsView(weeklyPlanId: string) {
  return weeklyChainRows(weeklyPlanId)
    .map(link => {
      const head = chainHead(link.chainLineageId);
      return head
        ? {
            lineageId: link.chainLineageId,
            carryover: link.carryover,
            trigger: head.trigger,
            friendlyCueTitle: head.friendlyCueTitle,
            zone: head.zone,
            kind: head.kind,
            reward: head.rewardText,
            status: head.status,
          }
        : null;
    })
    .filter((c): c is NonNullable<typeof c> => c !== null);
}

/** Pretty-ish compact render for playbook context (the byte-verbatim echo is
 * the AGENT's job from the template; this is the current-state readout). */
export function renderWeeklyForPlaybook(row: WeeklyRow): string {
  const chains = weeklyChainsView(row.id);
  const byZone = (zone: string) => chains.filter(c => c.zone === zone);
  const lines = [`# Week of ${row.weekOf}`, `**Theme:** ${row.theme ?? "(none)"}`, ""];
  for (const [zone, label] of [
    ["before_work", "BEFORE WORK"],
    ["during_work", "DURING WORK"],
    ["after_work", "AFTER WORK"],
  ] as const) {
    const zc = byZone(zone);
    if (zc.length === 0) continue;
    lines.push(`## ${label}`);
    for (const c of zc)
      lines.push(`- ${c.trigger} · "${c.friendlyCueTitle}" · ${c.kind} · ${c.carryover ?? "new"} · :D ${c.reward ?? ""}`);
    lines.push("");
  }
  if (row.leisurePoolJson) lines.push(`Leisure: ${(JSON.parse(row.leisurePoolJson) as string[]).join(", ")}`);
  if (row.datedEventsJson)
    lines.push(
      `Events: ${(JSON.parse(row.datedEventsJson) as { date: string; title: string }[]).map(e => `${e.date} ${e.title}`).join(" · ")}`,
    );
  if (row.bigRewardJson) {
    const br = JSON.parse(row.bigRewardJson) as { description: string; milestone: string };
    lines.push(`Big reward: ${br.description}, when ${br.milestone}`);
  }
  if (row.doOnceJson) lines.push(`Do once: ${(JSON.parse(row.doOnceJson) as string[]).join(", ")}`);
  return lines.join("\n");
}

/** The maturing recurring set (minimum-viable derivation per migration §5
 * open decision): chains that a PRIOR week of this era carried with
 * carryover "continued" — running on autopilot, selectable by dailies. */
export function recurringChainSet(monthlyPlanId: string, beforeWeekOf: string): string[] {
  const weeks = db
    .select()
    .from(weeklyPlan)
    .where(and(eq(weeklyPlan.monthlyPlanId, monthlyPlanId), isNull(weeklyPlan.supersededByPlanId)))
    .all()
    .filter(w => w.weekOf < beforeWeekOf);
  const lineages = new Set<string>();
  for (const week of weeks) {
    for (const link of weeklyChainRows(week.id)) {
      if (link.carryover === "continued") lineages.add(link.chainLineageId);
    }
  }
  return [...lineages];
}
