import { and, desc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { db } from "../db";
import { conversation, experiment, extraction, proposal } from "../db/schema";
import { getConfig } from "./config";

// The activity status, DERIVED entirely from existing tables — no logging,
// no new write path, can't drift from reality. Every signal here is a stage
// of the user's own pipeline: intake fed, gates drained, engine loaded.

export interface Vitals {
  lastAcceptedRantAt: string | null; // when a rant last entered the system
  daysSinceLastRant: number | null; // null = no rant ever (cold start)
  lastExtractionConfirmedAt: string | null;
  lastProposalResolvedAt: string | null;
  lastVisitAt: string | null;
  pendingCandidates: number; // intake gate backlog
  awaitingReadBack: number; // extraction gate backlog
  pendingProposals: number; // ratification gate backlog
  experiment: {
    running: { id: string; title: string; dayN: number; plannedDurationDays: number | null } | null;
    queueDepth: number; // queued + scheduling
    lastEndedAt: string | null;
    daysSinceEnded: number | null;
  };
}

export function localDate(ts: string): string {
  return new Date(ts).toLocaleDateString("en-CA");
}

// Whole local days between two YYYY-MM-DD dates (b - a).
export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);
}

function daysSince(ts: string | null, asOf: string): number | null {
  return ts === null ? null : Math.max(0, daysBetween(localDate(ts), asOf));
}

export function computeVitals(asOf: string): Vitals {
  // A rant "entered" when it was accepted through the intake gate; legacy
  // slug-era rows (distilled before the gate existed) count via createdAt.
  const lastAccepted = db
    .select({ ts: sql<string | null>`max(coalesce(${conversation.rantResolvedAt}, ${conversation.createdAt}))` })
    .from(conversation)
    .where(
      and(
        eq(conversation.distillRequested, true),
        isNull(conversation.parseError),
      ),
    )
    .get()?.ts ?? null;
  const legacyDistilled = db
    .select({ ts: sql<string | null>`max(${conversation.createdAt})` })
    .from(conversation)
    .where(isNotNull(conversation.distilledAt))
    .get()?.ts ?? null;
  const lastAcceptedRantAt =
    [lastAccepted, legacyDistilled].filter((t): t is string => t !== null).sort().at(-1) ?? null;

  const lastConfirm = db
    .select({ ts: sql<string | null>`max(${extraction.confirmedAt})` })
    .from(extraction)
    .get()?.ts ?? null;
  const lastResolved = db
    .select({ ts: sql<string | null>`max(${proposal.resolvedAt})` })
    .from(proposal)
    .get()?.ts ?? null;

  const pendingCandidates = db
    .select({ id: conversation.id })
    .from(conversation)
    .where(eq(conversation.rantStatus, "proposed"))
    .all().length;
  const awaitingReadBack = db
    .select({ id: conversation.id })
    .from(conversation)
    .where(and(isNotNull(conversation.distilledAt), isNull(conversation.extractionsReviewedAt)))
    .all().length;
  const pendingProposals = db
    .select({ id: proposal.id })
    .from(proposal)
    .where(eq(proposal.status, "pending"))
    .all().length;

  const running = db.select().from(experiment).where(eq(experiment.status, "running")).get() ?? null;
  const queueDepth = db
    .select({ id: experiment.id })
    .from(experiment)
    .where(inArray(experiment.status, ["queued", "scheduling"]))
    .all().length;
  const lastEnded = db
    .select({ ts: experiment.endedAt })
    .from(experiment)
    .where(and(inArray(experiment.status, ["succeeded", "failed"]), isNotNull(experiment.endedAt)))
    .orderBy(desc(experiment.endedAt))
    .limit(1)
    .get()?.ts ?? null;

  return {
    lastAcceptedRantAt,
    daysSinceLastRant: daysSince(lastAcceptedRantAt, asOf),
    lastExtractionConfirmedAt: lastConfirm,
    lastProposalResolvedAt: lastResolved,
    lastVisitAt: getConfig<string | null>("LAST_VISIT_AT"),
    pendingCandidates,
    awaitingReadBack,
    pendingProposals,
    experiment: {
      running: running
        ? {
            id: running.id,
            title: running.title,
            dayN: running.startedAt ? daysBetween(localDate(running.startedAt), asOf) + 1 : 1,
            plannedDurationDays: running.plannedDurationDays,
          }
        : null,
      queueDepth,
      lastEndedAt: lastEnded,
      daysSinceEnded: daysSince(lastEnded, asOf),
    },
  };
}
