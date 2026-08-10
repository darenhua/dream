import { desc, isNull } from "drizzle-orm";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db";
import { monthlyPlan } from "../db/schema";
import { todayLocal } from "../lib/time";
import { emit } from "./events";
import { ArtifactRefusal, RevisionConflict } from "./flowErrors";
import type { SaveOutcome, SessionRow } from "./planningFlows";

// The monthly ERA (WO-3, TARGET §8 MonthlyPlan): the planning top horizon.
// Pick and the group inbox are fully sunset on this path (user ruling C8) —
// monthly-create direct-writes the era; nothing planning-shaped touches the
// review membrane. Periods are user-chosen; era sanity only, never
// calendar-month checks (C4). Promises are append/revise-only at the write
// boundary — walk-backs happen in conversation, never in the save.

export const PromiseSchema = z
  .object({
    id: z.string().min(1).optional(), // echo back for revisions; omitted = new
    kind: z.enum(["habit", "event"]),
    title: z.string().trim().min(1).max(300),
    doneDefinition: z.string().trim().min(1).max(1_000),
    floorOrCadence: z.string().trim().max(300).optional(), // habits: "1/week, never rises"
    date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(), // events: the anchor weeks work back from
    provenance: z.string().regex(/^(this-session|carried:.+)$/, 'provenance must be "this-session" or "carried:<source>"'),
  })
  .strict();

export const MonthlyPlanArtifactSchema = z
  .object({
    title: z.string().trim().min(1).max(200), // "Ten weeks of audacity"
    periodStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    periodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    theme: z.string().trim().min(1).max(500),
    themeSubline: z.string().trim().max(1_000).optional(),
    story: z.string().trim().min(1).max(20_000), // the floor is theme + story
    promises: z.array(PromiseSchema).max(30).default([]),
    subordinateNotes: z.unknown().optional(),
    sourceConversationId: z.string().optional(),
  })
  .strict();
export type MonthlyPlanArtifact = z.infer<typeof MonthlyPlanArtifactSchema>;

export type StoredPromise = MonthlyPlanArtifact["promises"][number] & { id: string; addedAt: string };

type MonthlyRow = typeof monthlyPlan.$inferSelect;

export function promisesOf(row: MonthlyRow): StoredPromise[] {
  return JSON.parse(row.promisesJson) as StoredPromise[];
}

/** The active era for a date: not superseded, period covers (or has not yet
 * ended by) the date. Newest periodStart wins. */
export function activeEra(date?: string): MonthlyRow | null {
  const forDate = date ?? todayLocal();
  return (
    db
      .select()
      .from(monthlyPlan)
      .where(isNull(monthlyPlan.supersededByPlanId))
      .orderBy(desc(monthlyPlan.periodStart))
      .all()
      .find(row => row.periodStart <= forDate && row.periodEnd >= forDate) ?? null
  );
}

/** The most recent era regardless of expiry — prior-era story for the
 * monthly-create opener ("celebrate it, never audit it"). */
export function latestEra(): MonthlyRow | null {
  return (
    db
      .select()
      .from(monthlyPlan)
      .where(isNull(monthlyPlan.supersededByPlanId))
      .orderBy(desc(monthlyPlan.periodStart))
      .limit(1)
      .get() ?? null
  );
}

export function monthlyById(id: string): MonthlyRow | null {
  return db.select().from(monthlyPlan).where(eq(monthlyPlan.id, id)).get() ?? null;
}

function parseArtifact(plan: unknown): MonthlyPlanArtifact {
  const parsed = MonthlyPlanArtifactSchema.safeParse(plan);
  if (!parsed.success)
    throw new ArtifactRefusal(parsed.error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join("; "));
  return parsed.data;
}

function assertEraSanity(artifact: MonthlyPlanArtifact) {
  if (artifact.periodEnd <= artifact.periodStart) throw new ArtifactRefusal("periodEnd must be after periodStart");
  const days = (Date.parse(artifact.periodEnd) - Date.parse(artifact.periodStart)) / 86_400_000;
  if (days > 400) throw new ArtifactRefusal("an era longer than ~13 months is a life plan, not an era — shorten it");
  for (const p of artifact.promises) {
    if (p.kind === "event" && !p.date) throw new ArtifactRefusal(`event promise "${p.title}" needs a date`);
  }
}

/** monthly-create: direct write. No inbox, no pick, no group. */
export function createMonthly(_session: SessionRow, plan: unknown): SaveOutcome {
  const artifact = parseArtifact(plan);
  assertEraSanity(artifact);
  if (artifact.periodEnd < todayLocal()) throw new ArtifactRefusal("the era ends in the past — pick a live period");
  const existing = activeEra();
  if (existing)
    throw new ArtifactRefusal(
      `an era ("${existing.title}") is already active — update it, or supersede it explicitly (that conversation is bigger than a create)`,
    );
  const now = new Date().toISOString();
  const stored: StoredPromise[] = artifact.promises.map(p => ({ ...p, id: p.id ?? crypto.randomUUID(), addedAt: now }));
  const row = db
    .insert(monthlyPlan)
    .values({
      title: artifact.title,
      periodStart: artifact.periodStart,
      periodEnd: artifact.periodEnd,
      theme: artifact.theme,
      themeSubline: artifact.themeSubline ?? null,
      story: artifact.story,
      promisesJson: JSON.stringify(stored),
      subordinateNotesJson: artifact.subordinateNotes != null ? JSON.stringify(artifact.subordinateNotes) : null,
      sourceConversationId: artifact.sourceConversationId ?? null,
    })
    .returning()
    .get();
  emit("monthly_plan", row.id, "monthly_plan_created", { periodStart: row.periodStart, periodEnd: row.periodEnd });
  return { planId: row.id, revision: row.revision, period: `${row.periodStart} → ${row.periodEnd}` };
}

/** monthly-update: surgical. Promise set is append/revise-only; era may be
 * extended, never shrunk; periodStart is immutable. */
export function updateMonthly(session: SessionRow, plan: unknown): SaveOutcome {
  const target = session.targetPlanId ? monthlyById(session.targetPlanId) : activeEra();
  if (!target) throw new ArtifactRefusal("no era to update — this flow should have been a create");
  if (session.initialPlanRevision != null && target.revision !== session.initialPlanRevision)
    throw new RevisionConflict(session.initialPlanRevision, target.revision);

  const artifact = parseArtifact(plan);
  assertEraSanity(artifact);
  if (artifact.periodStart !== target.periodStart)
    throw new ArtifactRefusal("periodStart is immutable — the era began when it began");
  if (artifact.periodEnd < target.periodEnd)
    throw new ArtifactRefusal("shortening the era is a walk-back — extend it or leave it");

  const existingPromises = promisesOf(target);
  const payloadIds = new Set(artifact.promises.map(p => p.id).filter(Boolean));
  for (const existing of existingPromises) {
    if (!payloadIds.has(existing.id))
      throw new ArtifactRefusal(
        `promise removed ("${existing.title}") — promises are append/revise-only; name the walk-back in conversation instead`,
      );
  }
  const now = new Date().toISOString();
  const byId = new Map(existingPromises.map(p => [p.id, p]));
  const stored: StoredPromise[] = artifact.promises.map(p => {
    if (p.id && byId.has(p.id)) {
      const prior = byId.get(p.id)!;
      return { ...p, id: p.id, addedAt: prior.addedAt, provenance: p.provenance ?? prior.provenance };
    }
    return { ...p, id: p.id ?? crypto.randomUUID(), addedAt: now };
  });

  db.update(monthlyPlan)
    .set({
      title: artifact.title,
      periodEnd: artifact.periodEnd,
      theme: artifact.theme,
      themeSubline: artifact.themeSubline ?? null,
      story: artifact.story,
      promisesJson: JSON.stringify(stored),
      subordinateNotesJson: artifact.subordinateNotes != null ? JSON.stringify(artifact.subordinateNotes) : null,
      revision: target.revision + 1,
    })
    .where(eq(monthlyPlan.id, target.id))
    .run();
  emit("monthly_plan", target.id, "monthly_plan_updated", { revision: target.revision + 1 });
  return {
    planId: target.id,
    revision: target.revision + 1,
    period: `${target.periodStart} → ${artifact.periodEnd}`,
  };
}

/** The one-pager rendered in the ECHO.monthly shape — playbook context for
 * updates, and the era-as-story block weekly briefings quote. */
export function renderMonthlyOnePager(row: MonthlyRow): string {
  const promises = promisesOf(row);
  const habits = promises.filter(p => p.kind === "habit");
  const events = promises.filter(p => p.kind === "event");
  const lines: string[] = [
    `# ${row.title}`,
    `**${row.periodStart} → ${row.periodEnd}**${promises.length === 0 ? " · *work in progress*" : ""}`,
    "",
    "## Theme",
    `> **${row.theme}**`,
  ];
  if (row.themeSubline) lines.push(`> ${row.themeSubline}`);
  lines.push("", "## Story", row.story, "", "## Promises", "", "**Habits**");
  if (habits.length === 0) lines.push("- — none yet —");
  for (const p of habits)
    lines.push(
      `- **${p.title}.** ${p.doneDefinition}${p.floorOrCadence ? ` ${p.floorOrCadence}.` : ""}${p.provenance.startsWith("carried:") ? ` *(carried from ${p.provenance.slice(8)} — keep it?)*` : ""}`,
    );
  lines.push("", "**Events**");
  if (events.length === 0) lines.push("- — none yet —");
  for (const p of events)
    lines.push(
      `- **${p.title}** — ${p.date}. ${p.doneDefinition}${p.provenance.startsWith("carried:") ? ` *(carried from ${p.provenance.slice(8)} — keep it?)*` : ""}`,
    );
  if (row.subordinateNotesJson) {
    lines.push("", "---", `*${JSON.stringify(JSON.parse(row.subordinateNotesJson))}*`);
  }
  return lines.join("\n");
}
