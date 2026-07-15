import { and, eq, inArray, isNotNull, lt } from "drizzle-orm";
import { db } from "../db";
import { conversation, experiment, proposal, reviewWriteup } from "../db/schema";
import { getConfig } from "./config";
import { enqueueOutbound } from "./outbox";
import { listWitnesses, scopedGoalIds } from "./witnesses";
import { visibleExperimentIds } from "./witnessScope";

// Duty pings: visible-but-ducking. Unlike strikes (total disengagement),
// these fire when a SPECIFIC obligation goes stale — factual template lines
// routed to the friends scoped to see them. One ping per staleness episode
// via dedupeKey; never a counter, never escalation.

function fill(template: string, vars: Record<string, string>): string {
  return Object.entries(vars).reduce((t, [k, v]) => t.replaceAll(`{{${k}}}`, v), template);
}

export function runDutyPings(): Record<string, unknown> {
  const report: Record<string, unknown> = {};

  // 1. Review silence: experiment ended, no approved writeup, past the window.
  const reviewHours = getConfig<number>("DUTY_PING_REVIEW_HOURS");
  const cutoff = new Date(Date.now() - reviewHours * 3_600_000).toISOString();
  const endedUnreviewed = db
    .select()
    .from(experiment)
    .where(and(inArray(experiment.status, ["succeeded", "failed"]), isNotNull(experiment.endedAt), lt(experiment.endedAt, cutoff)))
    .all()
    .filter(e => {
      const rw = db.select().from(reviewWriteup).where(eq(reviewWriteup.experimentId, e.id)).get();
      return !rw || rw.status !== "approved";
    });

  const witnesses = listWitnesses().filter(w => w.status === "active" || w.status === "invited");
  let reviewPings = 0;
  for (const e of endedUnreviewed) {
    const days = Math.max(1, Math.round((Date.now() - Date.parse(e.endedAt!)) / 86_400_000));
    const body = fill(getConfig<string>("TEMPLATE.duty_ping_review"), {
      EXPERIMENT: e.title,
      DAYS: String(days),
    });
    for (const w of witnesses) {
      if (!visibleExperimentIds(w.id).includes(e.id)) continue; // scope holds for pings too
      const row = enqueueOutbound({
        witnessId: w.id,
        kind: "duty_ping",
        bodyText: body,
        relatedType: "experiment",
        relatedId: e.id,
        dedupeKey: `review_silence:${e.id}:${w.id}`,
      });
      if (row) reviewPings++;
    }
  }
  report.reviewSilence = { staleExperiments: endedUnreviewed.length, pings: reviewPings };

  // 2. Backlog aging: pending proposals / unresolved candidates going stale.
  //    Routed to the PRIMARY only (it's about the loop, not a specific goal).
  const backlogDays = getConfig<number>("DUTY_PING_PROPOSAL_DAYS");
  const backlogCutoff = new Date(Date.now() - backlogDays * 86_400_000).toISOString();
  const staleProposals = db
    .select({ id: proposal.id })
    .from(proposal)
    .where(and(eq(proposal.status, "pending"), lt(proposal.createdAt, backlogCutoff)))
    .all();
  const staleCandidates = db
    .select({ id: conversation.id })
    .from(conversation)
    .where(and(eq(conversation.rantStatus, "proposed"), lt(conversation.rantDetectedAt, backlogCutoff)))
    .all();

  const primary = witnesses.find(w => w.isPrimary);
  if (primary && scopedGoalIds(primary.id).length > 0 && (staleProposals.length > 0 || staleCandidates.length > 0)) {
    const what = [
      staleProposals.length > 0 ? `${staleProposals.length} unreviewed proposal${staleProposals.length === 1 ? "" : "s"}` : null,
      staleCandidates.length > 0 ? `${staleCandidates.length} unsorted rant${staleCandidates.length === 1 ? "" : "s"}` : null,
    ]
      .filter(Boolean)
      .join(" and ");
    const oldest = staleProposals[0]?.id ?? staleCandidates[0]?.id ?? "none";
    const row = enqueueOutbound({
      witnessId: primary.id,
      kind: "duty_ping",
      bodyText: fill(getConfig<string>("TEMPLATE.duty_ping_backlog"), { WHAT: what }),
      dedupeKey: `backlog:${oldest}`, // episode key = the oldest stale item
    });
    report.backlog = { staleProposals: staleProposals.length, staleCandidates: staleCandidates.length, pinged: row !== null };
  } else {
    report.backlog = { staleProposals: staleProposals.length, staleCandidates: staleCandidates.length, pinged: false };
  }

  return report;
}
