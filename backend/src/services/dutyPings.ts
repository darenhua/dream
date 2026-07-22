import { and, eq, inArray, isNotNull, lt } from "drizzle-orm";
import { db } from "../db";
import { conversation, currentFocus, experiment, experimentGroup, proposal, reviewWriteup } from "../db/schema";
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
    .where(
      and(
        eq(experiment.kind, "actionable"),
        inArray(experiment.status, ["succeeded", "failed"]),
        isNotNull(experiment.endedAt),
        lt(experiment.endedAt, cutoff),
      ),
    )
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

  // 3. Actionable coverage: this is a reminder-only signal about a change
  // group the user already chose. It never crafts, queues, schedules, or
  // starts an experiment. Groups with a queued/scheduling/running actionable
  // are covered; groups with no current running leaf are reported separately
  // so callers can distinguish "next is ready" from "nothing approved yet".
  // Coverage belongs only to the deliberately chosen current focus. This keeps
  // reminder-only accountability from treating old or merely candidate groups
  // as obligations.
  const focus = db.select().from(currentFocus).where(eq(currentFocus.status, "current")).get();
  const activeGroups = focus
    ? db
        .select()
        .from(experimentGroup)
        .where(and(eq(experimentGroup.id, focus.experimentGroupId), eq(experimentGroup.status, "active")))
        .all()
    : [];
  const coverageRows = activeGroups.length
    ? db
        .select({ experimentGroupId: experiment.experimentGroupId, status: experiment.status, endedAt: experiment.endedAt })
        .from(experiment)
        .where(and(eq(experiment.kind, "actionable"), inArray(experiment.experimentGroupId, activeGroups.map(group => group.id))))
        .all()
    : [];
  const runningGroupIds = new Set(
    coverageRows.filter(row => row.status === "running" && row.experimentGroupId).map(row => row.experimentGroupId!),
  );
  const coveredGroupIds = new Set(
    coverageRows
      .filter(row => ["queued", "scheduling", "running"].includes(row.status) && row.experimentGroupId)
      .map(row => row.experimentGroupId!),
  );
  const groupsWithoutRunning = activeGroups.filter(group => !runningGroupIds.has(group.id));
  const groupsWithoutApprovedActionable = activeGroups.filter(group => !coveredGroupIds.has(group.id));
  const actionableHours = getConfig<number>("DUTY_PING_ACTIONABLE_HOURS");
  const actionableCutoff = new Date(Date.now() - actionableHours * 3_600_000).toISOString();
  // The quiet window restarts after a completed weekly actionable. Otherwise
  // an old group would be pinged immediately after the user finishes a week,
  // which turns a gentle coverage reminder into an automatic pressure cycle.
  const coverageAbsentSince = new Map<string, string>();
  for (const group of groupsWithoutApprovedActionable) {
    const latestEnded = coverageRows
      .filter(row => row.experimentGroupId === group.id && row.endedAt)
      .map(row => row.endedAt!)
      .sort()
      .at(-1);
    coverageAbsentSince.set(group.id, latestEnded ?? group.createdAt);
  }
  const eligibleGroups = groupsWithoutApprovedActionable.filter(
    group => coverageAbsentSince.get(group.id)! < actionableCutoff,
  );
  let actionablePings = 0;
  if (primary) {
    for (const group of eligibleGroups) {
      const episode = coverageAbsentSince.get(group.id)!;
      const row = enqueueOutbound({
        witnessId: primary.id,
        kind: "duty_ping",
        bodyText: getConfig<string>("TEMPLATE.duty_ping_actionable"),
        relatedType: "experiment_group",
        relatedId: group.id,
        dedupeKey: `actionable_coverage:${group.id}:${episode}`,
      });
      if (row) actionablePings++;
    }
  }
  report.actionableCoverage = {
    activeGroups: activeGroups.length,
    groupsWithoutRunning: groupsWithoutRunning.length,
    groupsWithoutApprovedActionable: groupsWithoutApprovedActionable.length,
    eligibleGroups: eligibleGroups.length,
    pings: actionablePings,
  };

  return report;
}
