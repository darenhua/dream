import { and, asc, eq, gte, lte } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db";
import { chainRun, currentFocus, winEntry } from "../db/schema";
import { todayLocal } from "../lib/time";
import { latestPick } from "./prioritize";

// The evidence ledger (PLANNING_REVAMP_SPEC §4.4). Auto wins come from chain
// runs; conversational wins are harvested by the review conversation, which
// always happens BEFORE the next plan. Progress is compared only against the
// user's own trajectory — the ledger exists so the brain can't erase it.

export const WinKindSchema = z.enum([
  "action",
  "created",
  "courage",
  "selfcare",
  "identity",
  "lesson",
  "recognition",
]);

export const AddWinsSchema = z
  .array(
    z
      .object({
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        kind: WinKindSchema,
        text: z.string().trim().min(1).max(2_000),
      })
      .strict(),
  )
  .min(1)
  .max(40);

/** Conversational wins from a review conversation (direct write). */
export function addWins(raw: unknown) {
  const entries = AddWinsSchema.parse(raw);
  const rows = entries.map(entry =>
    db
      .insert(winEntry)
      .values({ ...entry, source: "conversation" })
      .returning()
      .get(),
  );
  return rows;
}

function entriesBetween(from: string, to: string) {
  return db
    .select()
    .from(winEntry)
    .where(and(gte(winEntry.date, from), lte(winEntry.date, to)))
    .orderBy(asc(winEntry.date), asc(winEntry.createdAt))
    .all();
}

function runStats(from: string, to: string) {
  const runs = db
    .select()
    .from(chainRun)
    .where(and(gte(chainRun.date, from), lte(chainRun.date, to)))
    .all();
  return {
    armed: runs.length,
    completed: runs.filter(r => r.completedAt != null).length,
    minimum: runs.filter(r => r.completedAt != null && r.minimumOnly === 1).length,
  };
}

function groupByKind(entries: (typeof winEntry.$inferSelect)[]) {
  const grouped: Record<string, { text: string; date: string; source: string }[]> = {};
  for (const e of entries) {
    (grouped[e.kind] ??= []).push({ text: e.text, date: e.date, source: e.source });
  }
  return grouped;
}

export function winsForDate(date: string) {
  const entries = entriesBetween(date, date);
  return {
    date,
    entries,
    byKind: groupByKind(entries),
    runs: runStats(date, date),
    reviewed: entries.some(e => e.source === "conversation"),
  };
}

function addDays(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function winsForWeek(weekOf: string) {
  const end = addDays(weekOf, 6);
  const entries = entriesBetween(weekOf, end);
  const perDay = Array.from({ length: 7 }, (_, i) => {
    const date = addDays(weekOf, i);
    const dayEntries = entries.filter(e => e.date === date);
    return { date, count: dayEntries.length, runs: runStats(date, date) };
  });
  return { weekOf, entries, byKind: groupByKind(entries), perDay, runs: runStats(weekOf, end) };
}

/** Wins across a pick's period (the monthly horizon). */
export function winsForFocus(focusId?: string) {
  const focus = focusId
    ? db.select().from(currentFocus).where(eq(currentFocus.id, focusId)).get()
    : latestPick()?.pick;
  if (!focus) return null;
  const from = focus.startedAt.slice(0, 10);
  const to = [focus.endDate ?? todayLocal(), todayLocal()].sort()[0]!; // min(endDate, today)
  const entries = entriesBetween(from, to);
  return { focusId: focus.id, from, to, entries, byKind: groupByKind(entries), runs: runStats(from, to) };
}

/** Days that produced evidence but were never reviewed: completed runs exist,
 * no conversational wins. The next planning conversation opens with these —
 * soft enforcement of review-before-plan; a missed evening never blocks the
 * morning. */
export function unreviewedDays(limit = 7): string[] {
  const today = todayLocal();
  const runs = db.select().from(chainRun).where(lte(chainRun.date, today)).all();
  const withEvidence = new Set(runs.filter(r => r.completedAt != null && r.date < today).map(r => r.date));
  if (!withEvidence.size) return [];
  const reviewed = new Set(
    db
      .select()
      .from(winEntry)
      .where(eq(winEntry.source, "conversation"))
      .all()
      .map(e => e.date),
  );
  return [...withEvidence]
    .filter(date => !reviewed.has(date))
    .sort()
    .reverse()
    .slice(0, limit);
}
