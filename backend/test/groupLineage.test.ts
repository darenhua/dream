import { beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db, wipeAllTables } from "../src/db";
import { app } from "../src/api/app";
import {
  calendarEvent,
  currentFocus,
  experiment,
  experimentGroup,
  experimentGroupGoal,
  goal,
  organizedGoal,
  organizedGoalSource,
  outboundMessage,
} from "../src/db/schema";
import {
  applyCollaborationChangeSet,
  createCollaborationInvite,
  redeemCollaborationCode,
  saveCollaborationDraft,
  submitCollaborationDraft,
} from "../src/services/collaboration";
import {
  archiveExperimentGroup,
  organizedEntityDetail,
  organizedFeed,
  restoreExperimentGroup,
} from "../src/services/organized";
import { seedConfig } from "../src/services/config";

function rawGoal(title = "own my mornings") {
  return db.insert(goal).values({ title, status: "active", origin: "derived" }).returning().get();
}

function organizedGoalFixture(rawGoalId: string, title = "higher agency") {
  const row = db
    .insert(organizedGoal)
    .values({ title, identityClause: null, synthesisMd: null, priorityRank: null, status: "active" })
    .returning()
    .get();
  db.insert(organizedGoalSource).values({ organizedGoalId: row.id, entityType: "goal", entityId: rawGoalId }).run();
  return row;
}

function candidateGroupFixture(organizedGoalIds: string[], title = "throw events", parentId: string | null = null) {
  const row = db
    .insert(experimentGroup)
    .values({ title, motivationMd: "why this change matters", parentExperimentGroupId: parentId, status: "candidate" })
    .returning()
    .get();
  for (const organizedGoalId of organizedGoalIds) {
    db.insert(experimentGroupGoal).values({ experimentGroupId: row.id, organizedGoalId }).run();
  }
  return row;
}

function applyPickFocus(groupId: string, organizedGoalIds: string[]) {
  const { code } = createCollaborationInvite({
    mode: "prioritize",
    prioritizeAction: "pick",
    userSeedMd: "Choose this change group and its goal focus.",
  });
  const { workspace } = redeemCollaborationCode(code);
  const draft = saveCollaborationDraft(workspace.id, {
    summaryMd: "# Pick current focus",
    operations: [
      {
        type: "set_current_focus",
        entryReason: "pick",
        selection: { kind: "existing", experimentGroupId: groupId },
        organizedGoalIds,
        reasoningMd: "This is the change group I am choosing to serve now.",
      },
    ],
  });
  submitCollaborationDraft(workspace.id);
  const applied = applyCollaborationChangeSet(draft.id);
  if (!applied.ok) throw new Error(applied.error);
  return applied;
}

beforeEach(() => {
  wipeAllTables();
  seedConfig();
});

describe("experiment group lineage", () => {
  test("a branch stores its parent, starts candidate, and both feed and detail expose shallow lineage", () => {
    const raw = rawGoal();
    const organized = organizedGoalFixture(raw.id);
    const parent = candidateGroupFixture([organized.id], "throw events");
    const child = candidateGroupFixture([organized.id], "start with improv", parent.id);

    expect(child.status).toBe("candidate");
    expect(child.parentExperimentGroupId).toBe(parent.id);

    const feed = organizedFeed();
    const feedChild = feed.groups.find(group => group.id === child.id)!;
    expect(feedChild.parent).toMatchObject({ id: parent.id, title: "throw events", status: "candidate" });
    const feedParent = feed.groups.find(group => group.id === parent.id)!;
    expect(feedParent.children).toEqual([
      expect.objectContaining({ id: child.id, title: "start with improv" }),
    ]);

    const detail = organizedEntityDetail("group", child.id)!;
    expect((detail as { parent: { id: string } | null }).parent?.id).toBe(parent.id);
  });

  test("the generic creator group contract rejects parent and lifecycle fields", () => {
    const raw = rawGoal();
    const organized = organizedGoalFixture(raw.id);
    const parent = candidateGroupFixture([organized.id], "existing parent");
    const { code } = createCollaborationInvite({
      mode: "experiment_group",
      userSeedMd: "a new change story",
      selectedOrganizedGoalIds: [organized.id],
    });
    const { workspace } = redeemCollaborationCode(code);

    const base = {
      type: "upsert_experiment_group" as const,
      title: "a new change story",
      organizedGoalIds: [organized.id],
    };
    for (const smuggled of [
      { parentExperimentGroupId: parent.id },
      { status: "done" },
      { status: "archived" },
      { closingReviewMd: "closing early" },
    ]) {
      expect(() =>
        saveCollaborationDraft(workspace.id, {
          summaryMd: "# smuggle attempt",
          operations: [{ ...base, ...smuggled }],
        }),
      ).toThrow();
    }
    expect(db.select().from(experimentGroup).all()).toHaveLength(1);
  });

  test("a prioritize new-group selection rejects a parent field", () => {
    const raw = rawGoal();
    const organized = organizedGoalFixture(raw.id);
    const parent = candidateGroupFixture([organized.id], "existing parent");
    const { code } = createCollaborationInvite({
      mode: "prioritize",
      prioritizeAction: "pick",
      userSeedMd: "Pick a new focus.",
    });
    const { workspace } = redeemCollaborationCode(code);

    expect(() =>
      saveCollaborationDraft(workspace.id, {
        summaryMd: "# pick with smuggled lineage",
        operations: [
          {
            type: "set_current_focus",
            entryReason: "pick",
            // The extra field is the point: the runtime schema must reject it.
            selection: {
              kind: "new",
              title: "a branch through the wrong door",
              parentExperimentGroupId: parent.id,
              organizedGoalIds: [organized.id],
            } as unknown as { kind: "new"; title: string; organizedGoalIds: string[] },
            organizedGoalIds: [organized.id],
            reasoningMd: "trying to manufacture lineage outside the companion",
          },
        ],
      }),
    ).toThrow();
    expect(db.select().from(currentFocus).all()).toHaveLength(0);
  });
});

describe("experiment group archive and restore", () => {
  test("a noncurrent parent archives while its branch stays visible and can still resolve the archived parent", () => {
    const raw = rawGoal();
    const organized = organizedGoalFixture(raw.id);
    const parent = candidateGroupFixture([organized.id], "throw events");
    const child = candidateGroupFixture([organized.id], "start with improv", parent.id);

    const archived = archiveExperimentGroup(parent.id)!;
    expect(archived).toMatchObject({ status: "archived", archivedFromStatus: "candidate" });
    expect(archived.archivedAt).toBeTruthy();

    const feed = organizedFeed();
    expect(feed.groups.map(group => group.id)).not.toContain(parent.id);
    expect(feed.groups.map(group => group.id)).toContain(child.id);
    expect(feed.archivedGroupCount).toBe(1);
    expect(feed.archivedGroups.map(group => group.id)).toContain(parent.id);

    // The visible branch still names its archived parent instead of losing lineage.
    const feedChild = feed.groups.find(group => group.id === child.id)!;
    expect(feedChild.parent).toMatchObject({ id: parent.id, status: "archived" });
    expect(feedChild.parent?.archivedAt).toBeTruthy();

    // Direct detail keeps resolving the archived row.
    expect(organizedEntityDetail("group", parent.id)).toMatchObject({ id: parent.id, status: "archived" });

    // A branch can also be created under an already archived parent.
    const lateBranch = candidateGroupFixture([organized.id], "later spinoff", parent.id);
    expect(organizedFeed().groups.find(group => group.id === lateBranch.id)?.parent?.status).toBe("archived");
  });

  test("the current focused group and a group with a live actionable cannot archive", () => {
    const raw = rawGoal();
    const organized = organizedGoalFixture(raw.id);
    const focused = candidateGroupFixture([organized.id], "current story");
    applyPickFocus(focused.id, [organized.id]);
    expect(() => archiveExperimentGroup(focused.id)).toThrow(/reviewed sunset|cannot be archived/);

    const idle = candidateGroupFixture([organized.id], "idle story");
    db.insert(experiment)
      .values({ title: "one week", kind: "actionable", experimentGroupId: idle.id, status: "queued", weekOf: "2026-07-13" })
      .run();
    expect(() => archiveExperimentGroup(idle.id)).toThrow(/actionable/);
    expect(db.select().from(experimentGroup).where(eq(experimentGroup.id, idle.id)).get()?.status).toBe("candidate");
  });

  test("archive and restore are side-effect free and never produce an active group", () => {
    const raw = rawGoal();
    const organized = organizedGoalFixture(raw.id);
    const focused = candidateGroupFixture([organized.id], "current story");
    applyPickFocus(focused.id, [organized.id]);
    const bystander = candidateGroupFixture([organized.id], "parked story");
    const focusBefore = db.select().from(currentFocus).where(eq(currentFocus.status, "current")).get()!;

    archiveExperimentGroup(bystander.id);
    const restored = restoreExperimentGroup(bystander.id)!;
    expect(restored).toMatchObject({ status: "candidate", archivedAt: null, archivedFromStatus: null });

    // Focus, ranks, calendar, and messaging are untouched by both operations.
    expect(db.select().from(currentFocus).where(eq(currentFocus.status, "current")).get()).toMatchObject({
      id: focusBefore.id,
      experimentGroupId: focused.id,
    });
    expect(db.select().from(organizedGoal).where(eq(organizedGoal.id, organized.id)).get()?.priorityRank).toBe(0);
    expect(db.select().from(calendarEvent).all()).toHaveLength(0);
    expect(db.select().from(outboundMessage).all()).toHaveLength(0);

    // Archiving cannot touch the already archived, restore refuses non-archived.
    expect(() => restoreExperimentGroup(bystander.id)).toThrow(/only an archived/);
    archiveExperimentGroup(bystander.id);
    expect(() => archiveExperimentGroup(bystander.id)).toThrow(/already archived/);
  });

  test("restore requires an explicit state when no pre-archive state was recorded, and never restores to active", async () => {
    const raw = rawGoal();
    const organized = organizedGoalFixture(raw.id);
    const legacy = candidateGroupFixture([organized.id], "legacy archived row");
    // Simulate a row archived before archive history existed.
    db.update(experimentGroup)
      .set({ status: "archived", archivedAt: null, archivedFromStatus: null })
      .where(eq(experimentGroup.id, legacy.id))
      .run();

    expect(() => restoreExperimentGroup(legacy.id)).toThrow(/no recorded pre-archive state/);
    const viaRoute = await app.request(`/api/organized/groups/${legacy.id}/restore`, {
      method: "POST",
      body: JSON.stringify({ restoreAs: "active" }),
    });
    expect(viaRoute.status).toBe(400);
    expect(restoreExperimentGroup(legacy.id, "done")).toMatchObject({ status: "done" });
  });

  test("the archive routes work end to end and a later reviewed pick can select a branch", async () => {
    const raw = rawGoal();
    const organized = organizedGoalFixture(raw.id);
    const parent = candidateGroupFixture([organized.id], "throw events");
    const branch = candidateGroupFixture([organized.id], "start with improv", parent.id);

    const archiveResponse = await app.request(`/api/organized/groups/${parent.id}/archive`, {
      method: "POST",
      body: "{}",
    });
    expect(archiveResponse.status).toBe(200);
    expect(((await archiveResponse.json()) as { status: string }).status).toBe("archived");

    // The reviewed pick still activates the branch of an archived parent while
    // preserving exactly one current focus / one active group.
    applyPickFocus(branch.id, [organized.id]);
    const active = db.select().from(experimentGroup).where(eq(experimentGroup.status, "active")).all();
    expect(active).toHaveLength(1);
    expect(active[0]?.id).toBe(branch.id);
    expect(active[0]?.parentExperimentGroupId).toBe(parent.id);
    expect(db.select().from(currentFocus).where(eq(currentFocus.status, "current")).all()).toHaveLength(1);
    expect(db.select().from(experimentGroup).where(eq(experimentGroup.id, parent.id)).get()?.status).toBe("archived");

    const missing = await app.request(`/api/organized/groups/${crypto.randomUUID()}/archive`, { method: "POST", body: "{}" });
    expect(missing.status).toBe(404);
  });
});
