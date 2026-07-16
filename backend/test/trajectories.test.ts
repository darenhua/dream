import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { db, wipeAllTables } from "../src/db";
import { startBackendServer } from "../src/api/httpServer";
import {
  calendarEvent,
  companionBranchDraft,
  conversation,
  currentFocus,
  currentFocusGoal,
  draftChangeSet,
  experiment,
  experimentGroup,
  experimentGroupGoal,
  experimentGroupSource,
  experimentTask,
  extraction,
  extractionLink,
  goal,
  organizedGoal,
  organizedGoalSource,
  outboundMessage,
} from "../src/db/schema";
import { env } from "../src/lib/env";
import {
  applyCollaborationChangeSet,
  collaborationMcpBackend,
  createCollaborationInvite,
  redeemCollaborationCode,
  saveCollaborationDraft,
  submitCollaborationDraft,
} from "../src/services/collaboration";
import { configureCollaborationMcpBackend } from "../src/mcp/server";
import { seedConfig } from "../src/services/config";

/**
 * Release-gate trajectories (REVISED_MEGA_SPEC §12.6): a deterministic mock
 * conversational agent drives the REAL production request dispatcher over
 * genuine localhost Streamable HTTP — Bun.serve on 127.0.0.1:0 with the
 * actual socket peer path — including the real dashboard review/apply HTTP
 * boundary. Redacted transcript/tool-call artifacts are persisted under the
 * untracked thoughts/ directory for the independent review pass.
 */

let server: ReturnType<typeof startBackendServer>;
let base = "";
const loopbackOriginal = env.COMPANION_ALLOW_LOOPBACK_OWNER;

type TranscriptStep = {
  at: string;
  actor: "user" | "dashboard" | "agent" | "tool" | "assert";
  label: string;
  detail?: unknown;
};

class Trajectory {
  steps: TranscriptStep[] = [];
  #secrets: string[] = [];

  constructor(readonly name: string) {}

  secret(value: string) {
    if (value) this.#secrets.push(value);
  }

  note(actor: TranscriptStep["actor"], label: string, detail?: unknown) {
    this.steps.push({ at: new Date().toISOString(), actor, label, detail: this.#redact(detail) });
  }

  #redact(value: unknown): unknown {
    if (value === undefined) return undefined;
    let text = JSON.stringify(value);
    for (const secret of this.#secrets) {
      text = text.replaceAll(secret, "[REDACTED]");
    }
    return JSON.parse(text);
  }

  serialize() {
    return { trajectory: this.name, recordedAt: new Date().toISOString(), steps: this.steps };
  }
}

const transcripts: Trajectory[] = [];

function trajectory(name: string) {
  const t = new Trajectory(name);
  transcripts.push(t);
  return t;
}

/** A deterministic scripted MCP conversation over the real network. */
class MockAgent {
  #client: Client;
  #transport: StreamableHTTPClientTransport;

  constructor(
    endpoint: string,
    readonly t: Trajectory,
    name = "mock-conversational-agent",
  ) {
    this.#client = new Client({ name, version: "1.0.0" });
    this.#transport = new StreamableHTTPClientTransport(new URL(endpoint));
  }

  async connect() {
    await this.#client.connect(this.#transport);
    this.t.note("agent", "connected over Streamable HTTP");
  }

  async listToolNames(): Promise<string[]> {
    const tools = await this.#client.listTools();
    const names = tools.tools.map(tool => tool.name).sort();
    this.t.note("agent", "listed tools", names);
    return names;
  }

  async call(name: string, args: Record<string, unknown> = {}) {
    const result = await this.#client.callTool({ name, arguments: args });
    const content = (result as { content?: { type: string; text?: string }[] }).content ?? [];
    const text = content.find(item => item.type === "text")?.text ?? "";
    const isError = (result as { isError?: boolean }).isError === true;
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    this.t.note("tool", name, { arguments: args, isError, result: json ?? text.slice(0, 2_000) });
    return { text, isError, json: json as never };
  }

  async close() {
    await this.#client.close().catch(() => {});
  }
}

async function dashboard(t: Trajectory, path: string, init: RequestInit & { capability?: string } = {}) {
  const { capability, ...request } = init;
  const headers = new Headers(request.headers);
  if (capability) headers.set("x-collaboration-capability", capability);
  if (request.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  const response = await fetch(`${base}/api${path}`, { ...request, headers });
  const body = (await response.json().catch(() => null)) as never;
  t.note("dashboard", `${request.method ?? "GET"} /api${path}`, { status: response.status, body });
  return { status: response.status, body: body as never };
}

// --- fixtures -------------------------------------------------------------

function seedRawGoalWithProvenance(title: string, rantText: string) {
  const convo = db
    .insert(conversation)
    .values({ source: "claude", externalId: crypto.randomUUID(), title: `rant: ${title}`, rawJson: "{}" })
    .returning()
    .get();
  const raw = db.insert(goal).values({ title, status: "active", origin: "derived" }).returning().get();
  const extracted = db
    .insert(extraction)
    .values({
      conversationId: convo.id,
      kind: "goal_talk",
      text: rantText,
      contentHash: "test-hash",
      origin: "agent",
      confirmedAt: new Date().toISOString(),
    })
    .returning()
    .get();
  db.insert(extractionLink).values({ extractionId: extracted.id, entityType: "goal", entityId: raw.id }).run();
  return { raw, convo, extracted };
}

function seedOrganizedGoal(title: string, rawGoalId: string) {
  const row = db
    .insert(organizedGoal)
    .values({ title, identityClause: null, synthesisMd: `why ${title} matters`, priorityRank: null, status: "active" })
    .returning()
    .get();
  db.insert(organizedGoalSource).values({ organizedGoalId: row.id, entityType: "goal", entityId: rawGoalId }).run();
  return row;
}

function seedCandidateGroup(title: string, organizedGoalIds: string[], sourceRawGoalId?: string) {
  const row = db
    .insert(experimentGroup)
    .values({ title, motivationMd: `the change story of ${title}`, status: "candidate" })
    .returning()
    .get();
  for (const organizedGoalId of organizedGoalIds) {
    db.insert(experimentGroupGoal).values({ experimentGroupId: row.id, organizedGoalId }).run();
  }
  if (sourceRawGoalId) {
    db.insert(experimentGroupSource).values({ experimentGroupId: row.id, entityType: "goal", entityId: sourceRawGoalId }).run();
  }
  return row;
}

/** Reviewed in-process pick used only as SETUP for later trajectories; the
 * network prioritize trajectory itself is exercised in its own test. */
function setupPickFocus(groupId: string, organizedGoalIds: string[]) {
  const { code } = createCollaborationInvite({
    mode: "prioritize",
    prioritizeAction: "pick",
    userSeedMd: "setup: choose the current change group",
  });
  const { workspace } = redeemCollaborationCode(code);
  saveCollaborationDraft(workspace.id, {
    summaryMd: "# setup pick",
    operations: [
      {
        type: "set_current_focus",
        entryReason: "pick",
        selection: { kind: "existing", experimentGroupId: groupId },
        organizedGoalIds,
        reasoningMd: "setup: this group serves the selected goals now",
      },
    ],
  });
  submitCollaborationDraft(workspace.id);
  const drafts = db.select().from(draftChangeSet).where(eq(draftChangeSet.workspaceId, workspace.id)).all();
  const applied = applyCollaborationChangeSet(drafts[0]!.id);
  if (!applied.ok) throw new Error(applied.error);
}

function nextMonday(): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + (((8 - date.getUTCDay()) % 7) || 7));
  return date.toISOString().slice(0, 10);
}

function assertNoExecutionSideEffects(t: Trajectory) {
  expect(db.select().from(calendarEvent).all()).toHaveLength(0);
  expect(db.select().from(outboundMessage).all()).toHaveLength(0);
  t.note("assert", "no calendar or witness/outbox rows were created");
}

// --- lifecycle ------------------------------------------------------------

beforeAll(() => {
  env.COMPANION_ALLOW_LOOPBACK_OWNER = true;
  // Another test file may have unregistered the MCP domain adapter in its
  // afterEach; the production wiring from app.ts must be active here.
  configureCollaborationMcpBackend(collaborationMcpBackend);
  server = startBackendServer({ hostname: "127.0.0.1", port: 0 });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => {
  await server.stop(true);
  env.COMPANION_ALLOW_LOOPBACK_OWNER = loopbackOriginal;
  const dir = join(import.meta.dir, "..", "..", "thoughts", "trajectories", `run-${new Date().toISOString().replaceAll(":", "-")}`);
  mkdirSync(dir, { recursive: true });
  for (const t of transcripts) {
    writeFileSync(join(dir, `${t.name}.json`), JSON.stringify(t.serialize(), null, 2));
  }
  writeFileSync(
    join(dir, "index.json"),
    JSON.stringify({ base: "127.0.0.1 ephemeral", trajectories: transcripts.map(t => t.name) }, null, 2),
  );
});

beforeEach(() => {
  wipeAllTables();
  seedConfig();
});

// --- trajectories ----------------------------------------------------------

describe("localhost Streamable HTTP MCP trajectories", () => {
  test("T1: a blank creator agent uses the code-linked index to draft a one-line organized goal", async () => {
    const t = trajectory("t1-creator-organized-goal");
    const fear = seedRawGoalWithProvenance("act despite fear of judgment", "I keep waiting until nobody could criticize the plan.");
    seedRawGoalWithProvenance("stop waiting for perfect plans", "I over-prepare instead of asking.");
    t.note("user", "presses + on Organized Goals with the one-line direction 'higher agency'");

    const invite = await dashboard(t, "/collaboration/invites", {
      method: "POST",
      body: JSON.stringify({ mode: "organized_goal", userSeedMd: "higher agency" }),
    });
    expect(invite.status).toBe(201);
    const { code, dashboardCapability, invite: inviteRow } = invite.body as {
      code: string;
      dashboardCapability: string;
      invite: { id: string };
    };
    t.secret(code);
    t.secret(dashboardCapability);

    const agent = new MockAgent(`${base}/mcp`, t, "blank-creator-agent");
    await agent.connect();
    const redeemed = await agent.call("redeem_collaboration_code", { code });
    expect(redeemed.isError).not.toBe(true);
    expect(redeemed.text).toContain("higher agency");

    const index = await agent.call("get_workspace_index", {});
    expect(index.isError).not.toBe(true);
    expect(index.text).toContain("higher agency");

    const search = await agent.call("search_workspace_index", { query: "fear" });
    const match = (search.json as { matches: { referenceType: string; id: string }[] }).matches[0]!;
    expect(match.referenceType).toBe("raw_goal");
    expect(match.id).toBe(fear.raw.id);

    const context = await agent.call("read_entity_context", { reference_type: match.referenceType, entity_id: match.id });
    expect(context.isError).not.toBe(true);
    const provenance = await agent.call("follow_provenance", { reference_type: match.referenceType, entity_id: match.id });
    expect(provenance.text).toContain("criticize");

    expect(db.select().from(organizedGoal).all()).toHaveLength(0);
    t.note("assert", "no organized goal exists before dashboard apply");

    const saved = await agent.call("save_draft_change_set", {
      summary_md:
        "# Higher agency\n\nThe user named this direction. Evidence: the confirmed extraction about waiting until nobody could criticize the plan.",
      operations: [
        {
          type: "upsert_organized_goal",
          title: "Higher agency",
          identityClause: "I act on what matters before I feel fully ready.",
          synthesisMd: "Grounded in the accepted raw goals about fear of judgment and over-preparation.",
          sources: [{ entityType: "goal", entityId: fear.raw.id }],
        },
      ],
      source_refs: [{ entity_type: "goal", entity_id: fear.raw.id, note: "primary evidence" }],
    });
    expect(saved.isError).not.toBe(true);
    const submitted = await agent.call("submit_draft_for_review", {});
    expect(submitted.isError).not.toBe(true);
    await agent.close();

    expect(db.select().from(organizedGoal).all()).toHaveLength(0);

    const status = await dashboard(t, `/collaboration/invites/${inviteRow.id}`, { capability: dashboardCapability });
    const changeSet = (status.body as { changeSet: { id: string; status: string } }).changeSet;
    expect(changeSet.status).toBe("ready_for_review");
    const applied = await dashboard(t, `/collaboration/change-sets/${changeSet.id}/apply`, {
      method: "POST",
      body: "{}",
      capability: dashboardCapability,
    });
    expect(applied.status).toBe(200);

    const organized = db.select().from(organizedGoal).all();
    expect(organized).toHaveLength(1);
    expect(organized[0]!.title).toBe("Higher agency");
    expect(
      db.select().from(organizedGoalSource).where(eq(organizedGoalSource.organizedGoalId, organized[0]!.id)).all(),
    ).toHaveLength(1);
    t.note("assert", "apply created exactly the user-initiated organized goal with provenance");
  });

  test("T2: group design preserves the user-selected goal scope and makes no calendar/witness write", async () => {
    const t = trajectory("t2-group-goal-scope");
    const raw = seedRawGoalWithProvenance("meet more people", "hosting things would force real invitations");
    const social = seedOrganizedGoal("live a more social life", raw.raw.id);
    const agency = seedOrganizedGoal("higher agency", raw.raw.id);
    t.note("user", "starts a change-group workspace for 'throw parties' serving two selected goals");

    const invite = await dashboard(t, "/collaboration/invites", {
      method: "POST",
      body: JSON.stringify({
        mode: "experiment_group",
        userSeedMd: "throw parties, starting from tiny housewarmings up to my own dj sets",
        selectedOrganizedGoalIds: [social.id, agency.id],
      }),
    });
    const { code, dashboardCapability, invite: inviteRow } = invite.body as { code: string; dashboardCapability: string; invite: { id: string } };
    t.secret(code);
    t.secret(dashboardCapability);

    const agent = new MockAgent(`${base}/mcp`, t, "group-design-agent");
    await agent.connect();
    await agent.call("redeem_collaboration_code", { code });
    await agent.call("get_workspace_index", {});

    // The scripted agent first tries to narrow the goal scope on its own;
    // the membrane must refuse, because the user selected the scope.
    const narrowed = await agent.call("save_draft_change_set", {
      summary_md: "# Throw parties (narrowed)",
      operations: [
        {
          type: "upsert_experiment_group",
          title: "throw parties",
          motivationMd: "hosting as the engine for social life",
          organizedGoalIds: [social.id],
        },
      ],
    });
    expect(narrowed.isError).toBe(true);
    t.note("assert", "a draft that drops a user-selected goal is rejected");

    const saved = await agent.call("save_draft_change_set", {
      summary_md: "# Throw parties\n\nOne coherent hosting story serving both selected goals.",
      operations: [
        {
          type: "upsert_experiment_group",
          title: "throw parties",
          motivationMd: "meeting people through hosting, from housewarmings to dj sets",
          organizedGoalIds: [social.id, agency.id],
          targets: [
            { kind: "experience", title: "host one tiny housewarming" },
            { kind: "habit", title: "one deliberate invitation per week" },
          ],
        },
      ],
      source_refs: [{ entity_type: "goal", entity_id: raw.raw.id }],
    });
    expect(saved.isError).not.toBe(true);
    await agent.call("submit_draft_for_review", {});
    await agent.close();

    const status = await dashboard(t, `/collaboration/invites/${inviteRow.id}`, { capability: dashboardCapability });
    const changeSet = (status.body as { changeSet: { id: string } }).changeSet;
    await dashboard(t, `/collaboration/change-sets/${changeSet.id}/apply`, { method: "POST", body: "{}", capability: dashboardCapability });

    const group = db.select().from(experimentGroup).where(eq(experimentGroup.title, "throw parties")).get()!;
    expect(group.status).toBe("candidate");
    const goalIds = db
      .select({ organizedGoalId: experimentGroupGoal.organizedGoalId })
      .from(experimentGroupGoal)
      .where(eq(experimentGroupGoal.experimentGroupId, group.id))
      .all()
      .map(row => row.organizedGoalId)
      .sort();
    expect(goalIds).toEqual([social.id, agency.id].sort());
    assertNoExecutionSideEffects(t);
  });

  test("T3: an actionable workspace reads the prior failed review before drafting a guilt-free week", async () => {
    const t = trajectory("t3-actionable-uses-failed-review");
    const raw = seedRawGoalWithProvenance("meet more people", "hosting forces invitations");
    const social = seedOrganizedGoal("live a more social life", raw.raw.id);
    const group = seedCandidateGroup("throw parties", [social.id], raw.raw.id);
    setupPickFocus(group.id, [social.id]);
    db.insert(experiment)
      .values({
        title: "host one housewarming",
        kind: "actionable",
        experimentGroupId: group.id,
        status: "failed",
        weekOf: "2026-07-06",
        reviewMd: "I got too scared to actually invite anyone; the ask was too big for week one.",
        endedAt: new Date().toISOString(),
      })
      .run();
    t.note("user", "opens the weekly actionable workspace for the current focused group");

    const invite = await dashboard(t, "/collaboration/invites", {
      method: "POST",
      body: JSON.stringify({
        mode: "actionable_experiment",
        experimentGroupId: group.id,
        userSeedMd: "design this week from what failed last week",
      }),
    });
    const { code, dashboardCapability, invite: inviteRow } = invite.body as { code: string; dashboardCapability: string; invite: { id: string } };
    t.secret(code);
    t.secret(dashboardCapability);

    const agent = new MockAgent(`${base}/mcp`, t, "actionable-design-agent");
    await agent.connect();
    await agent.call("redeem_collaboration_code", { code });
    const history = await agent.call("read_workspace_context", { section: "actionable_history" });
    expect(history.text).toContain("too scared");
    t.note("assert", "the agent read the prior failed week review before drafting");

    const saved = await agent.call("save_draft_change_set", {
      summary_md:
        "# A smaller week\n\nLast week failed because the ask was too big; this week shrinks the ask and adds a momentum task.",
      operations: [
        {
          type: "create_actionable_experiment",
          experimentGroupId: group.id,
          title: "one small invitation, one coffee",
          hypothesisMd: "Because the housewarming ask was too scary, a single low-stakes invitation builds momentum.",
          weekOf: nextMonday(),
          organizedGoalIds: [social.id],
          tasks: [
            { kind: "experience", title: "invite one friend to coffee", scheduleMode: "none" },
            {
              kind: "momentum",
              title: "draft the invitation message",
              scheduleMode: "calendar",
              scheduledFor: `${nextMonday()}T18:00:00.000Z`,
            },
          ],
          habitBlocks: [],
        },
      ],
    });
    expect(saved.isError).not.toBe(true);
    await agent.call("submit_draft_for_review", {});
    await agent.close();

    expect(
      db.select().from(experiment).where(and(eq(experiment.kind, "actionable"), eq(experiment.status, "queued"))).all(),
    ).toHaveLength(0);

    const status = await dashboard(t, `/collaboration/invites/${inviteRow.id}`, { capability: dashboardCapability });
    const changeSet = (status.body as { changeSet: { id: string } }).changeSet;
    const applied = await dashboard(t, `/collaboration/change-sets/${changeSet.id}/apply`, {
      method: "POST",
      body: "{}",
      capability: dashboardCapability,
    });
    expect(applied.status).toBe(200);

    const week = db
      .select()
      .from(experiment)
      .where(and(eq(experiment.kind, "actionable"), eq(experiment.status, "queued")))
      .get()!;
    expect(week.experimentGroupId).toBe(group.id);
    const tasks = db.select().from(experimentTask).where(eq(experimentTask.experimentId, week.id)).all();
    expect(tasks).toHaveLength(2);
    expect(tasks.every(task => task.status === "pending")).toBe(true);
    // Approval classifies tasks; calendar rows/pushes stay behind the separate
    // schedule-confirmation membrane.
    assertNoExecutionSideEffects(t);
  });

  test("T4: a no-code companion reads organized context and its branch draft creates nothing before dashboard apply", async () => {
    const t = trajectory("t4-companion-branch");
    const raw = seedRawGoalWithProvenance("meet more people", "improv came up as a smaller version of hosting");
    const social = seedOrganizedGoal("live a more social life", raw.raw.id);
    const parent = seedCandidateGroup("throw events", [social.id], raw.raw.id);
    t.note("user", "spontaneously messages the companion: 'maybe improv would help me get to throwing events'");

    const agent = new MockAgent(`${base}/companion-mcp`, t, "spontaneous-companion-agent");
    await agent.connect();
    const tools = await agent.listToolNames();
    expect(tools).not.toContain("redeem_collaboration_code");

    const overview = await agent.call("get_companion_overview", {});
    expect((overview.json as { overview: { groups: { candidate: { id: string }[] } } }).overview.groups.candidate[0]!.id).toBe(parent.id);

    const search = await agent.call("search_organized_context", { query: "events" });
    expect(search.text).toContain(parent.id);
    await agent.call("read_organized_context", { type: "experiment_group", id: parent.id });
    await agent.call("follow_organized_relations", { type: "experiment_group", id: parent.id });
    const provenance = await agent.call("follow_provenance", { entity_type: "goal", entity_id: raw.raw.id });
    expect(provenance.text).toContain("improv");

    t.note("agent", "asks: should improv be a branch of 'throw events', or just context for now?");
    t.note("user", "yes — make it a reviewable branch draft");

    const saved = await agent.call("save_branch_draft", {
      user_seed_md: "maybe improv would help me get to throwing events",
      summary_md: "# Branch: start with improv\n\nA lower-stakes intermediate step toward hosting, grounded in the hosting rant.",
      operations: [
        {
          type: "create_experiment_group_branch",
          parentExperimentGroupId: parent.id,
          title: "start with improv",
          motivationMd: "practice being seen in low-stakes rooms before hosting my own",
          organizedGoalIds: [social.id],
          targets: [{ kind: "experience", title: "attend one improv drop-in" }],
        },
      ],
      source_refs: [{ entity_type: "goal", entity_id: raw.raw.id }],
    });
    expect(saved.isError).not.toBe(true);
    await agent.call("submit_branch_draft", {});
    await agent.close();

    // Quarantine: one inbox row, still only the parent group, untouched state.
    expect(db.select().from(companionBranchDraft).all()).toHaveLength(1);
    expect(db.select().from(experimentGroup).all()).toHaveLength(1);
    expect(db.select().from(currentFocus).all()).toHaveLength(0);
    t.note("assert", "no domain row exists before dashboard apply");

    const list = await dashboard(t, "/companion/drafts");
    expect(list.status).toBe(200);
    const draftId = (list.body as { id: string }[])[0]!.id;
    const applied = await dashboard(t, `/companion/drafts/${draftId}/apply`, { method: "POST", body: "{}" });
    expect(applied.status).toBe(200);

    const groups = db.select().from(experimentGroup).all();
    expect(groups).toHaveLength(2);
    const child = groups.find(row => row.id !== parent.id)!;
    expect(child).toMatchObject({ title: "start with improv", status: "candidate", parentExperimentGroupId: parent.id });
    expect(db.select().from(experimentGroup).where(eq(experimentGroup.id, parent.id)).get()).toMatchObject({
      status: "candidate",
      title: "throw events",
    });
    assertNoExecutionSideEffects(t);
  });

  test("T5: reviewed pick then sunset across overlapping groups leaves exactly one active group and goal set", async () => {
    const t = trajectory("t5-pick-sunset-overlap");
    const raw = seedRawGoalWithProvenance("meet more people", "hosting and music overlap");
    const social = seedOrganizedGoal("live a more social life", raw.raw.id);
    const music = seedOrganizedGoal("be a distinctive musician", raw.raw.id);
    const hosting = seedCandidateGroup("throw events", [social.id], raw.raw.id);
    const musicGroup = seedCandidateGroup("music in public", [social.id, music.id], raw.raw.id);

    // --- reviewed Pick over real HTTP ---
    t.note("user", "presses Pick change group (no current focus exists)");
    const pickInvite = await dashboard(t, "/collaboration/invites", {
      method: "POST",
      body: JSON.stringify({ mode: "prioritize", prioritizeAction: "pick", userSeedMd: "what should I focus on first?" }),
    });
    const pick = pickInvite.body as never as { code: string; dashboardCapability: string; invite: { id: string } };
    t.secret(pick.code);
    t.secret(pick.dashboardCapability);

    const pickAgent = new MockAgent(`${base}/mcp`, t, "prioritize-pick-agent");
    await pickAgent.connect();
    await pickAgent.call("redeem_collaboration_code", { code: pick.code });
    const focusContext = await pickAgent.call("read_workspace_context", { section: "groups" });
    expect(focusContext.text).toContain("throw events");
    expect(focusContext.text).toContain("music in public");
    await pickAgent.call("save_draft_change_set", {
      summary_md: "# Pick: throw events first\n\nHosting unlocks the social base the music group also needs.",
      operations: [
        {
          type: "set_current_focus",
          entryReason: "pick",
          selection: { kind: "existing", experimentGroupId: hosting.id },
          organizedGoalIds: [social.id],
          reasoningMd: "Hosting serves the social goal directly and both candidate groups overlap on it.",
        },
      ],
    });
    await pickAgent.call("submit_draft_for_review", {});
    await pickAgent.close();

    const pickStatus = await dashboard(t, `/collaboration/invites/${pick.invite.id}`, { capability: pick.dashboardCapability });
    const pickChangeSet = (pickStatus.body as { changeSet: { id: string } }).changeSet;
    await dashboard(t, `/collaboration/change-sets/${pickChangeSet.id}/apply`, {
      method: "POST",
      body: "{}",
      capability: pick.dashboardCapability,
    });

    expect(db.select().from(experimentGroup).where(eq(experimentGroup.status, "active")).all().map(row => row.id)).toEqual([hosting.id]);
    expect(db.select().from(currentFocus).where(eq(currentFocus.status, "current")).all()).toHaveLength(1);
    t.note("assert", "pick produced exactly one active group and one current focus");

    // --- reviewed Sunset that atomically selects the overlapping group ---
    t.note("user", "presses Sunset on the current group and wants the music group next");
    const sunsetInvite = await dashboard(t, "/collaboration/invites", {
      method: "POST",
      body: JSON.stringify({
        mode: "prioritize",
        prioritizeAction: "sunset",
        experimentGroupId: hosting.id,
        userSeedMd: "hosting ran its course; the music direction should absorb it",
      }),
    });
    const sunset = sunsetInvite.body as never as { code: string; dashboardCapability: string; invite: { id: string } };
    t.secret(sunset.code);
    t.secret(sunset.dashboardCapability);

    const sunsetAgent = new MockAgent(`${base}/mcp`, t, "prioritize-sunset-agent");
    await sunsetAgent.connect();
    await sunsetAgent.call("redeem_collaboration_code", { code: sunset.code });
    await sunsetAgent.call("save_draft_change_set", {
      summary_md: "# Sunset hosting, focus music in public\n\nOne atomic reviewed transition.",
      operations: [
        {
          type: "set_current_focus",
          entryReason: "sunset",
          selection: { kind: "existing", experimentGroupId: musicGroup.id },
          organizedGoalIds: [music.id, social.id],
          reasoningMd: "The music group serves both goals; social stays selected through the overlap.",
          sunsetCurrentGroup: {
            experimentGroupId: hosting.id,
            status: "done",
            closingReviewMd: "Hosting built the base; the next story continues it.",
          },
        },
      ],
    });
    await sunsetAgent.call("submit_draft_for_review", {});
    await sunsetAgent.close();

    const sunsetStatus = await dashboard(t, `/collaboration/invites/${sunset.invite.id}`, { capability: sunset.dashboardCapability });
    const sunsetChangeSet = (sunsetStatus.body as { changeSet: { id: string } }).changeSet;
    const appliedSunset = await dashboard(t, `/collaboration/change-sets/${sunsetChangeSet.id}/apply`, {
      method: "POST",
      body: "{}",
      capability: sunset.dashboardCapability,
    });
    expect(appliedSunset.status).toBe(200);

    const active = db.select().from(experimentGroup).where(eq(experimentGroup.status, "active")).all();
    expect(active.map(row => row.id)).toEqual([musicGroup.id]);
    expect(db.select().from(experimentGroup).where(eq(experimentGroup.id, hosting.id)).get()?.status).toBe("done");
    const current = db.select().from(currentFocus).where(eq(currentFocus.status, "current")).all();
    expect(current).toHaveLength(1);
    const focusGoals = db
      .select()
      .from(currentFocusGoal)
      .where(eq(currentFocusGoal.currentFocusId, current[0]!.id))
      .orderBy(currentFocusGoal.priorityRank)
      .all();
    expect(focusGoals.map(row => row.organizedGoalId)).toEqual([music.id, social.id]);
    expect(db.select().from(organizedGoal).where(eq(organizedGoal.id, music.id)).get()?.priorityRank).toBe(0);
    expect(db.select().from(organizedGoal).where(eq(organizedGoal.id, social.id)).get()?.priorityRank).toBe(1);
    t.note("assert", "sunset atomically ended the old focus and left exactly one active group and ordered goal set");
    assertNoExecutionSideEffects(t);
  });

  test("T6: dashboard feedback revises the same draft rather than inventing a second primary entity", async () => {
    const t = trajectory("t6-feedback-revises-same-draft");
    const fear = seedRawGoalWithProvenance("act despite fear of judgment", "the plan waits until nobody could criticize it");
    t.note("user", "starts an organized-goal workspace, then sends the first draft back with feedback");

    const invite = await dashboard(t, "/collaboration/invites", {
      method: "POST",
      body: JSON.stringify({ mode: "organized_goal", userSeedMd: "higher agency" }),
    });
    const { code, dashboardCapability, invite: inviteRow } = invite.body as { code: string; dashboardCapability: string; invite: { id: string } };
    t.secret(code);
    t.secret(dashboardCapability);

    const agent = new MockAgent(`${base}/mcp`, t, "revision-loop-agent");
    await agent.connect();
    const redeemed = await agent.call("redeem_collaboration_code", { code });
    const workspaceId = (redeemed.json as { workspace: { id: string } }).workspace.id;
    await agent.call("save_draft_change_set", {
      summary_md: "# Agency\n\nFirst attempt.",
      operations: [
        {
          type: "upsert_organized_goal",
          title: "Agency",
          sources: [{ entityType: "goal", entityId: fear.raw.id }],
        },
      ],
    });
    await agent.call("submit_draft_for_review", {});

    const status = await dashboard(t, `/collaboration/invites/${inviteRow.id}`, { capability: dashboardCapability });
    const changeSet = (status.body as { changeSet: { id: string } }).changeSet;
    const rejected = await dashboard(t, `/collaboration/change-sets/${changeSet.id}/reject`, {
      method: "POST",
      body: JSON.stringify({ feedback: "Call it 'Higher agency' and keep the identity clause in my voice.", returnToDrafting: true }),
      capability: dashboardCapability,
    });
    expect(rejected.status).toBe(200);

    const reread = await agent.call("get_workspace", {});
    expect(reread.text).toContain("Higher agency");
    t.note("assert", "the agent can read the dashboard feedback on the same workspace");

    await agent.call("save_draft_change_set", {
      summary_md: "# Higher agency\n\nRevised per dashboard feedback: renamed and rephrased in the user's voice.",
      operations: [
        {
          type: "upsert_organized_goal",
          title: "Higher agency",
          identityClause: "I act on what matters before I feel fully ready.",
          sources: [{ entityType: "goal", entityId: fear.raw.id }],
        },
      ],
    });
    await agent.call("submit_draft_for_review", {});
    await agent.close();

    // The revision stayed one draft on one workspace.
    const drafts = db.select().from(draftChangeSet).where(eq(draftChangeSet.workspaceId, workspaceId)).all();
    expect(drafts).toHaveLength(1);

    const finalStatus = await dashboard(t, `/collaboration/invites/${inviteRow.id}`, { capability: dashboardCapability });
    const finalChangeSet = (finalStatus.body as { changeSet: { id: string; status: string } }).changeSet;
    expect(finalChangeSet.id).toBe(changeSet.id);
    await dashboard(t, `/collaboration/change-sets/${finalChangeSet.id}/apply`, {
      method: "POST",
      body: "{}",
      capability: dashboardCapability,
    });

    const organized = db.select().from(organizedGoal).all();
    expect(organized).toHaveLength(1);
    expect(organized[0]!.title).toBe("Higher agency");
    t.note("assert", "feedback produced a revision of the same draft and exactly one organized goal");
  });
});
