import { beforeEach, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { db, wipeAllTables } from "../src/db";
import { app } from "../src/api/app";
import {
  calendarEvent,
  collaborationInvite,
  collaborationWorkspace,
  collaborationWorkspaceIndex,
  draftChangeSet,
  event,
  experiment,
  experimentGroup,
  experimentGroupGoal,
  experimentTask,
  goal,
  organizedGoal,
  organizedGoalSource,
  outboundMessage,
} from "../src/db/schema";
import {
  applyCollaborationChangeSet,
  assertDashboardInviteCapability,
  createCollaborationInvite,
  collaborationMcpBackend,
  getCollaborationWorkspace,
  redeemCollaborationCode,
  saveCollaborationDraft,
  submitCollaborationDraft,
} from "../src/services/collaboration";
import { seedConfig } from "../src/services/config";
import { archiveExperiment, enqueueExperiment, listQueue, pickExperiment } from "../src/services/experiments";
import { closeExperimentGroup } from "../src/services/organized";

function rawGoal(title = "own my mornings") {
  return db.insert(goal).values({ title, status: "active", origin: "derived" }).returning().get();
}

function newGoalDraft(sourceGoalId: string, title = "higher agency") {
  return {
    summaryMd: `# ${title}\n\nA user-authored direction.`,
    operations: [
      {
        type: "upsert_organized_goal" as const,
        title,
        identityClause: "I act on what matters instead of waiting to feel ready.",
        synthesisMd: "This is a reviewed synthesis, not a raw proposal replacement.",
        priorityRank: 0,
        sources: [{ entityType: "goal" as const, entityId: sourceGoalId }],
      },
    ],
    sourceRefs: [{ entityType: "goal" as const, entityId: sourceGoalId }],
  };
}

function organizedGoalFixture(rawGoalId: string, title = "higher agency") {
  const row = db
    .insert(organizedGoal)
    .values({ title, identityClause: null, synthesisMd: null, priorityRank: 0, status: "active" })
    .returning()
    .get();
  db.insert(organizedGoalSource).values({ organizedGoalId: row.id, entityType: "goal", entityId: rawGoalId }).run();
  return row;
}

function applyGroup(organizedGoalId: string, title = "make room for music") {
  const { code } = createCollaborationInvite({
    mode: "experiment_group",
    userSeedMd: title,
    selectedOrganizedGoalIds: [organizedGoalId],
  });
  const { workspace } = redeemCollaborationCode(code);
  const draft = saveCollaborationDraft(workspace.id, {
    summaryMd: `# ${title}\n\nA durable change story, not a weekly calendar plan.`,
    operations: [
      {
        type: "upsert_experiment_group",
        title,
        motivationMd: "This is why the change matters.",
        organizedGoalIds: [organizedGoalId],
        targets: [{ kind: "project", title: "finish one song", status: "pending" }],
      },
    ],
  });
  submitCollaborationDraft(workspace.id);
  const applied = applyCollaborationChangeSet(draft.id);
  if (!applied.ok) throw new Error(applied.error);
  return db.select().from(experimentGroup).where(eq(experimentGroup.title, title)).get()!;
}

beforeEach(() => {
  wipeAllTables();
  seedConfig();
});

describe("collaboration invites and change sets", () => {
  test("every workspace requires a nonblank user-supplied starting direction", () => {
    expect(() => createCollaborationInvite({ mode: "organized_goal", userSeedMd: "   " })).toThrow();
    expect(() => createCollaborationInvite({ mode: "actionable_experiment", userSeedMd: "" })).toThrow();
  });

  test("a one-time invite preserves its dashboard seed and cannot be redeemed twice", () => {
    const invite = createCollaborationInvite({
      mode: "organized_goal",
      userSeedMd: "Higher agency",
    });

    const persisted = db.select().from(collaborationInvite).where(eq(collaborationInvite.id, invite.id)).get()!;
    expect(persisted.secretHash).not.toBe(invite.code);

    const redeemed = redeemCollaborationCode(`  ${invite.code.toLowerCase()}  `);
    expect(redeemed.workspace.userSeedMd).toBe("Higher agency");
    expect(redeemed.workspace.selectedOrganizedGoalIds).toEqual([]);
    expect(getCollaborationWorkspace(redeemed.workspace.id)?.status).toBe("open");

    expect(() => redeemCollaborationCode(invite.code)).toThrow("already been redeemed");
    expect(db.select().from(collaborationWorkspace).all()).toHaveLength(1);
    expect(db.select().from(organizedGoal).all()).toHaveLength(0);
  });

  test("redeeming a creator code persists a bounded index and only lets MCP drill into indexed references", async () => {
    const raw = rawGoal("build higher agency through small social risks");
    const invite = createCollaborationInvite({ mode: "organized_goal", userSeedMd: "higher agency" });
    const redeemed = redeemCollaborationCode(invite.code);
    const persisted = db
      .select()
      .from(collaborationWorkspaceIndex)
      .where(eq(collaborationWorkspaceIndex.workspaceId, redeemed.workspace.id))
      .get();

    expect(persisted).toBeTruthy();
    expect(persisted!.markdownIndex).toContain("higher agency");
    const index = await collaborationMcpBackend.getWorkspaceIndex(redeemed.workspace.id);
    expect(index.ok).toBe(true);
    if (!index.ok) throw new Error(index.error);
    expect(index.value.manifest.referenceCount).toBeGreaterThanOrEqual(1);

    const search = await collaborationMcpBackend.searchWorkspaceIndex({
      workspaceId: redeemed.workspace.id,
      query: "social risks",
    });
    expect(search.ok).toBe(true);
    if (!search.ok) throw new Error(search.error);
    const match = search.value.matches.find(item => item.id === raw.id);
    expect(match).toMatchObject({ referenceType: "raw_goal", title: raw.title });

    const detail = await collaborationMcpBackend.readEntityContext({
      workspaceId: redeemed.workspace.id,
      referenceType: "raw_goal",
      entityId: raw.id,
    });
    expect(detail.ok).toBe(true);
    if (!detail.ok) throw new Error(detail.error);
    expect(detail.value.markdown).toContain(raw.title);

    const outsideScope = await collaborationMcpBackend.readEntityContext({
      workspaceId: redeemed.workspace.id,
      referenceType: "raw_goal",
      entityId: crypto.randomUUID(),
    });
    expect(outsideScope.ok).toBe(false);
  });

  test("an expired code creates no workspace and records one expiry audit event", () => {
    const invite = createCollaborationInvite({ mode: "organized_goal", userSeedMd: "Higher agency" });
    db.update(collaborationInvite)
      .set({ expiresAt: new Date(Date.now() - 1_000).toISOString() })
      .where(eq(collaborationInvite.id, invite.id))
      .run();

    expect(() => redeemCollaborationCode(invite.code)).toThrow("expired");
    expect(() => redeemCollaborationCode(invite.code)).toThrow("expired");
    expect(db.select().from(collaborationWorkspace).all()).toHaveLength(0);
    expect(
      db
        .select()
        .from(event)
        .where(
          and(
            eq(event.entityType, "collaboration_invite"),
            eq(event.entityId, invite.id),
            eq(event.eventType, "collaboration_invite_expired"),
          ),
        )
        .all(),
    ).toHaveLength(1);
  });

  test("the dashboard review capability is independent of the MCP OTP", () => {
    const invite = createCollaborationInvite({ mode: "organized_goal", userSeedMd: "Higher agency" });
    const persisted = db.select().from(collaborationInvite).where(eq(collaborationInvite.id, invite.id)).get()!;

    expect(invite.code.replaceAll("-", "")).toHaveLength(26);
    expect(invite.dashboardCapability.length).toBeGreaterThanOrEqual(43);
    expect(persisted.dashboardSecretHash).not.toBe(invite.dashboardCapability);
    expect(assertDashboardInviteCapability(invite.id, invite.dashboardCapability).id).toBe(invite.id);
    expect(() => assertDashboardInviteCapability(invite.id, "not-the-dashboard-capability")).toThrow("capability");
  });

  test("dashboard collaboration routes require the invite capability", async () => {
    const invite = createCollaborationInvite({ mode: "organized_goal", userSeedMd: "Higher agency" });
    const withoutCapability = await app.request(`/api/collaboration/invites/${invite.id}`);
    expect(withoutCapability.status).toBe(403);
    expect((await app.request("/api/collaboration/change-sets?status=ready_for_review")).status).toBe(404);

    const withCapability = await app.request(`/api/collaboration/invites/${invite.id}`, {
      headers: { "x-collaboration-capability": invite.dashboardCapability },
    });
    expect(withCapability.status).toBe(200);
    expect((await withCapability.json() as { invite: { id: string } }).invite.id).toBe(invite.id);
  });

  test("dashboard apply and reject routes cannot be invoked without the workspace capability", async () => {
    const raw = rawGoal();
    const invite = createCollaborationInvite({ mode: "organized_goal", userSeedMd: "Higher agency" });
    const { workspace } = redeemCollaborationCode(invite.code);
    const draft = saveCollaborationDraft(workspace.id, newGoalDraft(raw.id));
    submitCollaborationDraft(workspace.id);

    expect(
      (await app.request(`/api/collaboration/change-sets/${draft.id}/apply`, { method: "POST" })).status,
    ).toBe(403);
    expect(
      (await app.request(`/api/collaboration/change-sets/${draft.id}/reject`, { method: "POST", body: "{}" })).status,
    ).toBe(403);
    expect(db.select().from(draftChangeSet).where(eq(draftChangeSet.id, draft.id)).get()!.status).toBe("ready_for_review");
    expect(db.select().from(organizedGoal).all()).toHaveLength(0);
  });

  test("saving and submitting a draft only changes workspace draft state", () => {
    const raw = rawGoal();
    const invite = createCollaborationInvite({ mode: "organized_goal", userSeedMd: "Higher agency" });
    const { workspace } = redeemCollaborationCode(invite.code);

    const draft = saveCollaborationDraft(workspace.id, newGoalDraft(raw.id));
    expect(draft.status).toBe("drafting");
    expect(db.select().from(organizedGoal).all()).toHaveLength(0);
    expect(db.select().from(experimentGroup).all()).toHaveLength(0);
    expect(db.select().from(calendarEvent).all()).toHaveLength(0);
    expect(db.select().from(outboundMessage).all()).toHaveLength(0);

    const submitted = submitCollaborationDraft(workspace.id);
    expect(submitted.status).toBe("ready_for_review");
    expect(getCollaborationWorkspace(workspace.id)?.status).toBe("draft_ready");
    expect(db.select().from(organizedGoal).all()).toHaveLength(0);
  });

  test("a workspace cannot create or replace an organized primary it was not opened for", () => {
    const raw = rawGoal();
    const existing = organizedGoalFixture(raw.id);
    const existingInvite = createCollaborationInvite({
      mode: "organized_goal",
      primaryEntityId: existing.id,
      userSeedMd: existing.title,
    });
    const existingWorkspace = redeemCollaborationCode(existingInvite.code).workspace;
    expect(() => saveCollaborationDraft(existingWorkspace.id, newGoalDraft(raw.id, "duplicate by omission"))).toThrow("primary entity");

    const newInvite = createCollaborationInvite({ mode: "organized_goal", userSeedMd: "a fresh direction" });
    const newWorkspace = redeemCollaborationCode(newInvite.code).workspace;
    const wrongTargetDraft = newGoalDraft(raw.id, "wrong target");
    expect(() =>
      saveCollaborationDraft(newWorkspace.id, {
        ...wrongTargetDraft,
        operations: [{ ...wrongTargetDraft.operations[0]!, id: existing.id }],
      }),
    ).toThrow("new workspace primary");
  });

  test("applying a reviewed change set materializes its organized entity and provenance atomically", () => {
    const raw = rawGoal();
    const { code } = createCollaborationInvite({ mode: "organized_goal", userSeedMd: "Higher agency" });
    const { workspace } = redeemCollaborationCode(code);
    const draft = saveCollaborationDraft(workspace.id, newGoalDraft(raw.id));
    submitCollaborationDraft(workspace.id);

    const applied = applyCollaborationChangeSet(draft.id);
    expect(applied.ok).toBe(true);
    if (!applied.ok) throw new Error(applied.error);

    const created = db.select().from(organizedGoal).where(eq(organizedGoal.title, "higher agency")).get()!;
    expect(created.priorityRank).toBe(0);
    expect(
      db
        .select()
        .from(organizedGoalSource)
        .where(andSource(created.id, raw.id))
        .get(),
    ).toBeTruthy();
    expect(db.select().from(draftChangeSet).where(eq(draftChangeSet.id, draft.id)).get()!.status).toBe("applied");
    expect(db.select().from(collaborationWorkspace).where(eq(collaborationWorkspace.id, workspace.id)).get()!.status).toBe(
      "applied",
    );
    expect(db.select().from(calendarEvent).all()).toHaveLength(0);
    expect(db.select().from(outboundMessage).all()).toHaveLength(0);
  });

  test("a later invalid operation rolls back the entire reviewed change set", () => {
    const raw = rawGoal();
    const { code } = createCollaborationInvite({ mode: "organized_goal", userSeedMd: "Higher agency" });
    const { workspace } = redeemCollaborationCode(code);
    const missingRawGoalId = "00000000-0000-4000-8000-000000000001";
    const invalidSourceDraft = newGoalDraft(raw.id);
    const draft = saveCollaborationDraft(workspace.id, {
      ...invalidSourceDraft,
      operations: [
        {
          ...invalidSourceDraft.operations[0]!,
          // Source existence is intentionally checked at reviewed apply time;
          // this proves the primary insert rolls back with a later failure.
          sources: [{ entityType: "goal" as const, entityId: missingRawGoalId }],
        },
      ],
    });
    submitCollaborationDraft(workspace.id);

    const applied = applyCollaborationChangeSet(draft.id);
    expect(applied.ok).toBe(false);
    expect(db.select().from(organizedGoal).all()).toHaveLength(0);
    expect(db.select().from(organizedGoalSource).all()).toHaveLength(0);
    expect(db.select().from(experimentGroup).all()).toHaveLength(0);
    expect(db.select().from(draftChangeSet).where(eq(draftChangeSet.id, draft.id)).get()!.status).toBe("ready_for_review");
    expect(getCollaborationWorkspace(workspace.id)?.status).toBe("draft_ready");
  });

  test("an applied change group records its selected organized goals without calendar or witness effects", () => {
    const raw = rawGoal();
    const organized = organizedGoalFixture(raw.id);

    const group = applyGroup(organized.id);

    expect(
      db
        .select()
        .from(experimentGroupGoal)
        .where(and(eq(experimentGroupGoal.experimentGroupId, group.id), eq(experimentGroupGoal.organizedGoalId, organized.id)))
        .get(),
    ).toBeTruthy();
    expect(db.select().from(calendarEvent).all()).toHaveLength(0);
    expect(db.select().from(outboundMessage).all()).toHaveLength(0);
  });

  test("closing a group requires its live weekly actionable to be explicitly resolved first", () => {
    const raw = rawGoal();
    const organized = organizedGoalFixture(raw.id);
    const group = applyGroup(organized.id);
    const actionable = db
      .insert(experiment)
      .values({
        title: "a week I am not starting",
        kind: "actionable",
        experimentGroupId: group.id,
        weekOf: "2026-07-20",
        status: "queued",
      })
      .returning()
      .get();

    expect(() => closeExperimentGroup(group.id, "sunset")).toThrow("resolve weekly actionable");
    expect(archiveExperiment(actionable.id).ok).toBe(true);
    expect(closeExperimentGroup(group.id, "sunset")?.status).toBe("sunset");
  });

  test("a new change-group workspace requires the dashboard's goal selection", () => {
    expect(() =>
      createCollaborationInvite({
        mode: "experiment_group",
        userSeedMd: "a change I want to make",
      }),
    ).toThrow("requires at least one user-selected organized goal");
  });

  test("a change-group draft cannot replace the dashboard-selected organized goals", () => {
    const raw = rawGoal();
    const selected = organizedGoalFixture(raw.id, "higher agency");
    const unselected = organizedGoalFixture(raw.id, "make more music");
    const { code } = createCollaborationInvite({
      mode: "experiment_group",
      userSeedMd: "a scoped change group",
      selectedOrganizedGoalIds: [selected.id],
    });
    const { workspace } = redeemCollaborationCode(code);

    expect(() =>
      saveCollaborationDraft(workspace.id, {
        summaryMd: "This must keep the selection the user made.",
        operations: [
          {
            type: "upsert_experiment_group",
            title: "wrong selected goals",
            organizedGoalIds: [unselected.id],
          },
        ],
      }),
    ).toThrow();
    expect(db.select().from(experimentGroup).all()).toHaveLength(0);
  });

  test("a non-group workspace cannot rewrite an existing change group as a related update", () => {
    const raw = rawGoal();
    const groupGoal = organizedGoalFixture(raw.id, "higher agency");
    const goalBeingEdited = organizedGoalFixture(raw.id, "make more music");
    const group = applyGroup(groupGoal.id);
    const { code } = createCollaborationInvite({
      mode: "organized_goal",
      primaryEntityId: goalBeingEdited.id,
      userSeedMd: "revise my music goal",
    });
    const { workspace } = redeemCollaborationCode(code);
    const primary = newGoalDraft(raw.id, "make more music").operations[0]!;

    expect(() =>
      saveCollaborationDraft(workspace.id, {
        summaryMd: "A goal conversation must not rewrite a group behind the user's back.",
        operations: [
          { ...primary, id: goalBeingEdited.id },
          {
            type: "upsert_experiment_group",
            id: group.id,
            title: "rewritten by a goal conversation",
            organizedGoalIds: [groupGoal.id],
          },
        ],
      }),
    ).toThrow("only an experiment-group workspace may revise a change group");
    expect(db.select().from(experimentGroup).where(eq(experimentGroup.id, group.id)).get()!.title).toBe(group.title);
  });

  test("an actionable draft cannot escape the group-selected organized goals", () => {
    const raw = rawGoal();
    const inGroup = organizedGoalFixture(raw.id, "higher agency");
    const outOfGroup = organizedGoalFixture(raw.id, "make more music");
    const group = applyGroup(inGroup.id);
    const { code } = createCollaborationInvite({
      mode: "actionable_experiment",
      experimentGroupId: group.id,
      selectedOrganizedGoalIds: [inGroup.id],
      userSeedMd: "a small week",
    });
    const { workspace } = redeemCollaborationCode(code);

    expect(() =>
      saveCollaborationDraft(workspace.id, {
        summaryMd: "This must stay in scope.",
        operations: [
          {
            type: "create_actionable_experiment",
            experimentGroupId: group.id,
            title: "off-scope week",
            weekOf: "2026-07-20",
            organizedGoalIds: [outOfGroup.id],
          },
        ],
      }),
    ).toThrow("outside this workspace's selected group goals");
    expect(db.select().from(experiment).all()).toHaveLength(0);
  });

  test("applying an actionable creates pending scheduled and unscheduled tasks but no calendar or witness rows", () => {
    const raw = rawGoal();
    const organized = organizedGoalFixture(raw.id);
    const group = applyGroup(organized.id);
    const { code } = createCollaborationInvite({
      mode: "actionable_experiment",
      experimentGroupId: group.id,
      selectedOrganizedGoalIds: [organized.id],
      userSeedMd: "a modest week",
    });
    const { workspace } = redeemCollaborationCode(code);
    const draft = saveCollaborationDraft(workspace.id, {
      summaryMd: "One guilt-free weekly leaf.",
      operations: [
        {
          type: "create_actionable_experiment",
          experimentGroupId: group.id,
          title: "make a tiny music week",
          hypothesisMd: "A smaller ask makes showing up realistic.",
          weekOf: "2026-07-20",
          organizedGoalIds: [organized.id],
          tasks: [
            { kind: "momentum", title: "open the music project", scheduleMode: "none" },
            {
              kind: "experience",
              title: "book a studio hour",
              scheduleMode: "calendar",
              scheduledFor: "2026-07-21T16:00:00.000Z",
            },
          ],
        },
      ],
    });
    submitCollaborationDraft(workspace.id);
    const applied = applyCollaborationChangeSet(draft.id);
    expect(applied.ok).toBe(true);

    const actionable = db.select().from(experiment).where(eq(experiment.title, "make a tiny music week")).get()!;
    expect(actionable.kind).toBe("actionable");
    expect(actionable.experimentGroupId).toBe(group.id);
    expect(actionable.status).toBe("queued");
    expect(actionable.plannedDurationDays).toBe(7);
    const tasks = db.select().from(experimentTask).where(eq(experimentTask.experimentId, actionable.id)).all();
    expect(tasks).toHaveLength(2);
    expect(tasks.every(task => task.status === "pending")).toBe(true);
    expect(tasks.find(task => task.title === "open the music project")?.scheduleMode).toBe("none");
    expect(tasks.find(task => task.title === "open the music project")?.scheduledFor).toBeNull();
    expect(tasks.find(task => task.title === "book a studio hour")?.scheduleMode).toBe("calendar");
    expect(db.select().from(calendarEvent).all()).toHaveLength(0);
    expect(db.select().from(outboundMessage).all()).toHaveLength(0);
  });

  test("actionable weeks must begin on a Monday", () => {
    const raw = rawGoal();
    const organized = organizedGoalFixture(raw.id);
    const group = applyGroup(organized.id);
    const { code } = createCollaborationInvite({
      mode: "actionable_experiment",
      experimentGroupId: group.id,
      userSeedMd: "a deliberately small week",
    });
    const { workspace } = redeemCollaborationCode(code);

    expect(() =>
      saveCollaborationDraft(workspace.id, {
        summaryMd: "This should be rejected before it can become a weekly leaf.",
        operations: [
          {
            type: "create_actionable_experiment",
            experimentGroupId: group.id,
            title: "wrong week boundary",
            weekOf: "2026-07-19",
            organizedGoalIds: [organized.id],
          },
        ],
      }),
    ).toThrow("valid Monday");
  });

  test("raw candidates are absent from the actionable scheduling queue", () => {
    const raw = rawGoal();
    const candidate = enqueueExperiment({
      title: "derived candidate",
      hypothesisMd: "A useful raw idea.",
      goalIds: [raw.id],
      proposalId: null as unknown as string,
    });

    expect(candidate.kind).toBe("candidate");
    expect(listQueue()).toEqual([]);
  });

  test("raw candidates cannot be picked into scheduling", () => {
    const raw = rawGoal();
    const candidate = enqueueExperiment({
      title: "derived candidate",
      hypothesisMd: "A useful raw idea.",
      goalIds: [raw.id],
      proposalId: null as unknown as string,
    });

    expect(pickExperiment(candidate.id)).toMatchObject({ ok: false });
    expect(db.select().from(experiment).where(eq(experiment.id, candidate.id)).get()!.status).toBe("queued");
  });
});

function andSource(organizedGoalId: string, rawGoalId: string) {
  return and(eq(organizedGoalSource.organizedGoalId, organizedGoalId), eq(organizedGoalSource.entityId, rawGoalId));
}
