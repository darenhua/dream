import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, wipeAllTables } from "../src/db";
import { app } from "../src/api/app";
import { PEER_ADDRESS_HEADER } from "../src/api/routes/companion";
import {
  calendarEvent,
  companionBranchDraft,
  currentFocus,
  experiment,
  experimentGroup,
  experimentGroupGoal,
  experimentGroupSource,
  goal,
  organizedGoal,
  organizedGoalSource,
  outboundMessage,
} from "../src/db/schema";
import { env } from "../src/lib/env";
import { CompanionMcpHttpServer } from "../src/mcp/companionHttp";
import { seedConfig } from "../src/services/config";

const envOriginal = {
  token: env.COMPANION_AUTH_TOKEN_SHA256,
  loopback: env.COMPANION_ALLOW_LOOPBACK_OWNER,
};

function sha256Hex(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function rawGoal(title = "own my mornings") {
  return db.insert(goal).values({ title, status: "active", origin: "derived" }).returning().get();
}

function organizedGoalFixture(rawGoalId: string, title = "live a more social life") {
  const row = db
    .insert(organizedGoal)
    .values({ title, identityClause: null, synthesisMd: "meet many people through things I host", priorityRank: null, status: "active" })
    .returning()
    .get();
  db.insert(organizedGoalSource).values({ organizedGoalId: row.id, entityType: "goal", entityId: rawGoalId }).run();
  return row;
}

function parentGroupFixture(organizedGoalId: string, rawGoalId: string, title = "throw events") {
  const row = db
    .insert(experimentGroup)
    .values({ title, motivationMd: "meeting people through hosting", status: "candidate" })
    .returning()
    .get();
  db.insert(experimentGroupGoal).values({ experimentGroupId: row.id, organizedGoalId }).run();
  db.insert(experimentGroupSource).values({ experimentGroupId: row.id, entityType: "goal", entityId: rawGoalId }).run();
  return row;
}

function branchOperations(parentId: string, organizedGoalId: string, title = "start with improv") {
  return [
    {
      type: "create_experiment_group_branch",
      parentExperimentGroupId: parentId,
      title,
      motivationMd: "an intermediate, lower-stakes step toward hosting",
      organizedGoalIds: [organizedGoalId],
      targets: [{ kind: "experience", title: "attend one improv drop-in" }],
    },
  ];
}

async function connectCompanion(
  host: CompanionMcpHttpServer,
  options: { peer?: () => string | undefined; token?: string } = {},
) {
  const client = new Client({ name: "companion-test-client", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL("http://dream.test/companion-mcp"), {
    fetch: (input, init) =>
      host.handle(
        input instanceof Request ? new Request(input, init) : new Request(String(input), init),
        options.peer?.(),
      ),
    requestInit: options.token ? { headers: { authorization: `Bearer ${options.token}` } } : undefined,
  });
  await client.connect(transport);
  return { client, transport };
}

function toolText(result: unknown): string {
  const content = (result as { content?: { type: string; text?: string }[] }).content;
  const first = content?.find(item => item.type === "text");
  if (!first?.text) throw new Error("expected text tool result");
  return first.text;
}

function inboxHeaders() {
  return { [PEER_ADDRESS_HEADER]: "127.0.0.1" };
}

beforeEach(() => {
  wipeAllTables();
  seedConfig();
  env.COMPANION_AUTH_TOKEN_SHA256 = "";
  env.COMPANION_ALLOW_LOOPBACK_OWNER = false;
});

afterEach(() => {
  env.COMPANION_AUTH_TOKEN_SHA256 = envOriginal.token;
  env.COMPANION_ALLOW_LOOPBACK_OWNER = envOriginal.loopback;
});

describe("companion authentication boundary", () => {
  test("an unconfigured deployment fails closed before any session exists", async () => {
    const host = new CompanionMcpHttpServer();
    await expect(connectCompanion(host, { peer: () => "127.0.0.1" })).rejects.toThrow();
    expect(host.sessionCount).toBe(0);
  });

  test("a wrong or missing bearer token fails before any session exists", async () => {
    env.COMPANION_AUTH_TOKEN_SHA256 = sha256Hex("the-real-high-entropy-token");
    const host = new CompanionMcpHttpServer();
    await expect(connectCompanion(host)).rejects.toThrow();
    await expect(connectCompanion(host, { token: "wrong-token" })).rejects.toThrow();
    expect(host.sessionCount).toBe(0);

    const { client } = await connectCompanion(host, { token: "the-real-high-entropy-token" });
    expect(host.sessionCount).toBe(1);
    await client.close();
  });

  test("the loopback-owner adapter grants only loopback socket peers", async () => {
    env.COMPANION_ALLOW_LOOPBACK_OWNER = true;
    const host = new CompanionMcpHttpServer();
    await expect(connectCompanion(host, { peer: () => "203.0.113.9" })).rejects.toThrow();
    await expect(connectCompanion(host, { peer: () => undefined })).rejects.toThrow();
    expect(host.sessionCount).toBe(0);

    const { client } = await connectCompanion(host, { peer: () => "127.0.0.1" });
    expect(host.sessionCount).toBe(1);
    await client.close();
  });

  test("a valid initialization followed by an unauthenticated continuation fails", async () => {
    env.COMPANION_ALLOW_LOOPBACK_OWNER = true;
    const host = new CompanionMcpHttpServer();
    let peer: string | undefined = "127.0.0.1";
    const { client } = await connectCompanion(host, { peer: () => peer });

    // The session id alone must not act as a bearer credential.
    peer = "203.0.113.9";
    await expect(client.callTool({ name: "get_companion_overview", arguments: {} })).rejects.toThrow();

    peer = "127.0.0.1";
    const ok = await client.callTool({ name: "get_companion_overview", arguments: {} });
    expect(toolText(ok)).toContain("organizedGoals");
    await client.close();
  });

  test("the companion endpoint exposes no creator tools and knows no creator sessions", async () => {
    env.COMPANION_ALLOW_LOOPBACK_OWNER = true;
    const host = new CompanionMcpHttpServer();
    const { client } = await connectCompanion(host, { peer: () => "127.0.0.1" });
    const tools = await client.listTools();
    const names = tools.tools.map(tool => tool.name);
    expect(names).not.toContain("redeem_collaboration_code");
    expect(names).not.toContain("save_draft_change_set");
    expect(names.sort()).toEqual(
      [
        "follow_organized_relations",
        "follow_provenance",
        "get_branch_draft",
        "get_companion_overview",
        "read_organized_context",
        "save_branch_draft",
        "search_organized_context",
        "submit_branch_draft",
      ].sort(),
    );
    await client.close();

    // A session id minted elsewhere (e.g. the creator endpoint) is unknown here.
    const foreignSession = await host.handle(
      new Request("http://dream.test/companion-mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-session-id": crypto.randomUUID(),
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      }),
      "127.0.0.1",
    );
    expect(foreignSession.status).toBe(404);
  });
});

describe("companion reads and quarantined branch drafting", () => {
  async function loopbackClient(host: CompanionMcpHttpServer) {
    env.COMPANION_ALLOW_LOOPBACK_OWNER = true;
    return connectCompanion(host, { peer: () => "127.0.0.1" });
  }

  test("organized-first reads work and raw provenance requires prior discovery", async () => {
    const raw = rawGoal();
    const organized = organizedGoalFixture(raw.id);
    const parent = parentGroupFixture(organized.id, raw.id);
    const host = new CompanionMcpHttpServer();
    const { client } = await loopbackClient(host);

    const overview = JSON.parse(toolText(await client.callTool({ name: "get_companion_overview", arguments: {} })));
    expect(overview.overview.groups.candidate.map((g: { id: string }) => g.id)).toContain(parent.id);

    const search = JSON.parse(toolText(await client.callTool({ name: "search_organized_context", arguments: { query: "events" } })));
    expect(search.results.some((hit: { id: string }) => hit.id === parent.id)).toBe(true);

    // A raw drill before any organized read returned that reference is refused.
    const early = await client.callTool({
      name: "follow_provenance",
      arguments: { entity_type: "goal", entity_id: raw.id },
    });
    expect(early.isError).toBe(true);

    const context = JSON.parse(
      toolText(await client.callTool({ name: "read_organized_context", arguments: { type: "experiment_group", id: parent.id } })),
    );
    expect(context.discoveredSources).toEqual([{ entityType: "goal", entityId: raw.id }]);

    const provenance = JSON.parse(
      toolText(await client.callTool({ name: "follow_provenance", arguments: { entity_type: "goal", entity_id: raw.id } })),
    );
    expect(provenance.ref).toEqual({ entityType: "goal", entityId: raw.id });
    await client.close();
  });

  test("save/submit writes only a quarantined draft; no group exists before dashboard apply", async () => {
    const raw = rawGoal();
    const organized = organizedGoalFixture(raw.id);
    const parent = parentGroupFixture(organized.id, raw.id);
    const host = new CompanionMcpHttpServer();
    const { client } = await loopbackClient(host);

    const saved = await client.callTool({
      name: "save_branch_draft",
      arguments: {
        user_seed_md: "improv might be an intermediate step toward throwing events",
        summary_md: "# Branch: start with improv\n\nLower-stakes practice for hosting.",
        operations: branchOperations(parent.id, organized.id),
      },
    });
    expect(saved.isError).not.toBe(true);
    const submitted = await client.callTool({ name: "submit_branch_draft", arguments: {} });
    expect(toolText(submitted)).toContain("ready_for_review");

    // Draft only: one inbox row, still exactly one experiment group.
    expect(db.select().from(companionBranchDraft).all()).toHaveLength(1);
    expect(db.select().from(experimentGroup).all()).toHaveLength(1);
    expect(db.select().from(currentFocus).all()).toHaveLength(0);
    await client.close();
  });

  test("the companion operation contract rejects every non-branch mutation", async () => {
    const raw = rawGoal();
    const organized = organizedGoalFixture(raw.id);
    const parent = parentGroupFixture(organized.id, raw.id);
    const host = new CompanionMcpHttpServer();
    const { client } = await loopbackClient(host);

    const rejectedOps = [
      [{ type: "upsert_experiment_group", title: "generic upsert", organizedGoalIds: [organized.id] }],
      [{ type: "set_current_focus", entryReason: "pick", selection: { kind: "existing", experimentGroupId: parent.id } }],
      [{ type: "create_actionable_experiment", experimentGroupId: parent.id, title: "a week" }],
      [{ type: "upsert_organized_goal", title: "invented goal" }],
      // Strict schema: no extra fields, even on the allowed operation.
      [{ ...branchOperations(parent.id, organized.id)[0], status: "active" }],
      // Parent is mandatory and must exist.
      [{ ...branchOperations(crypto.randomUUID(), organized.id)[0] }],
    ];
    for (const operations of rejectedOps) {
      const result = await client.callTool({
        name: "save_branch_draft",
        arguments: {
          user_seed_md: "an idea",
          summary_md: "# attempt",
          operations,
        },
      });
      expect(result.isError).toBe(true);
    }
    expect(db.select().from(companionBranchDraft).all()).toHaveLength(0);
    expect(db.select().from(experimentGroup).all()).toHaveLength(1);
    await client.close();
  });
});

describe("companion dashboard inbox", () => {
  function seedReadyDraft(identityId = "companion-owner") {
    const raw = rawGoal();
    const organized = organizedGoalFixture(raw.id);
    const parent = parentGroupFixture(organized.id, raw.id);
    const draft = db
      .insert(companionBranchDraft)
      .values({
        companionIdentityId: identityId,
        parentExperimentGroupId: parent.id,
        userSeedMd: "improv as a step toward events",
        summaryMd: "# Branch: start with improv",
        operationsJson: JSON.stringify(branchOperations(parent.id, organized.id)),
        sourceRefsJson: JSON.stringify([]),
        status: "ready_for_review",
      })
      .returning()
      .get();
    return { raw, organized, parent, draft };
  }

  test("inbox routes fail closed without a configured reviewer identity", async () => {
    const { draft } = seedReadyDraft();
    // Unconfigured deployment: even a loopback peer is refused.
    const unconfigured = await app.request("/api/companion/drafts", { headers: inboxHeaders() });
    expect(unconfigured.status).toBe(401);

    env.COMPANION_ALLOW_LOOPBACK_OWNER = true;
    const noPeer = await app.request("/api/companion/drafts");
    expect(noPeer.status).toBe(401);
    const applyNoPeer = await app.request(`/api/companion/drafts/${draft.id}/apply`, { method: "POST" });
    expect(applyNoPeer.status).toBe(401);
    expect(db.select().from(experimentGroup).all()).toHaveLength(1);
  });

  test("applying one reviewed draft atomically creates exactly one candidate branch", async () => {
    env.COMPANION_ALLOW_LOOPBACK_OWNER = true;
    const { organized, parent, draft } = seedReadyDraft();

    const list = await app.request("/api/companion/drafts", { headers: inboxHeaders() });
    expect(list.status).toBe(200);
    expect(((await list.json()) as { id: string }[]).map(row => row.id)).toContain(draft.id);

    const detail = await app.request(`/api/companion/drafts/${draft.id}`, { headers: inboxHeaders() });
    expect(((await detail.json()) as { parent: { id: string } }).parent.id).toBe(parent.id);

    const apply = await app.request(`/api/companion/drafts/${draft.id}/apply`, { method: "POST", headers: inboxHeaders() });
    expect(apply.status).toBe(200);
    const applied = (await apply.json()) as { createdGroupId: string };

    const child = db.select().from(experimentGroup).where(eq(experimentGroup.id, applied.createdGroupId)).get()!;
    expect(child).toMatchObject({ status: "candidate", parentExperimentGroupId: parent.id, title: "start with improv" });
    expect(
      db.select().from(experimentGroupGoal).where(eq(experimentGroupGoal.experimentGroupId, child.id)).all().map(row => row.organizedGoalId),
    ).toEqual([organized.id]);

    // Apply changed nothing else: parent intact, no focus/calendar/witness rows.
    expect(db.select().from(experimentGroup).where(eq(experimentGroup.id, parent.id)).get()?.status).toBe("candidate");
    expect(db.select().from(currentFocus).all()).toHaveLength(0);
    expect(db.select().from(calendarEvent).all()).toHaveLength(0);
    expect(db.select().from(outboundMessage).all()).toHaveLength(0);

    // The applied draft cannot apply twice.
    const again = await app.request(`/api/companion/drafts/${draft.id}/apply`, { method: "POST", headers: inboxHeaders() });
    expect(again.status).toBe(409);
    expect(db.select().from(experimentGroup).all()).toHaveLength(2);
  });

  test("rejecting a draft leaves the domain untouched and can return it to drafting", async () => {
    env.COMPANION_ALLOW_LOOPBACK_OWNER = true;
    const { draft } = seedReadyDraft();
    const reject = await app.request(`/api/companion/drafts/${draft.id}/reject`, {
      method: "POST",
      headers: inboxHeaders(),
      body: JSON.stringify({ feedback: "pick a smaller first ask", returnToDrafting: true }),
    });
    expect(reject.status).toBe(200);
    expect(db.select().from(companionBranchDraft).where(eq(companionBranchDraft.id, draft.id)).get()).toMatchObject({
      status: "drafting",
      rejectionNote: "pick a smaller first ask",
    });
    expect(db.select().from(experimentGroup).all()).toHaveLength(1);
  });

  test("one identity can never see or apply another identity's drafts", async () => {
    env.COMPANION_ALLOW_LOOPBACK_OWNER = true;
    const { draft } = seedReadyDraft("someone-else");

    const list = await app.request("/api/companion/drafts", { headers: inboxHeaders() });
    expect(((await list.json()) as { id: string }[]).map(row => row.id)).not.toContain(draft.id);

    const detail = await app.request(`/api/companion/drafts/${draft.id}`, { headers: inboxHeaders() });
    expect(detail.status).toBe(404);
    const apply = await app.request(`/api/companion/drafts/${draft.id}/apply`, { method: "POST", headers: inboxHeaders() });
    expect(apply.status).toBe(404);
    expect(db.select().from(experimentGroup).all()).toHaveLength(1);
  });
});
