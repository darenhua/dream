import { beforeEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { db, wipeAllTables } from "../src/db";
import { experimentIdea, organizedGoal } from "../src/db/schema";
import { DreamMcpHttpServer } from "../src/mcp/http";
import { applyRecordChangeSet, listRecordChangeSets, rejectRecordChangeSet } from "../src/services/recordChangeSets";

function text(result: unknown): string {
  const content = (result as { content: { type: string; text?: string }[] }).content;
  const first = content.find(item => item.type === "text");
  if (!first?.text) throw new Error("expected text result");
  return first.text;
}

async function connect(host: DreamMcpHttpServer) {
  const client = new Client({ name: "dream-test-client", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL("http://127.0.0.1/mcp"), {
    fetch: (input, init) =>
      host.handle(input instanceof Request ? new Request(input, init) : new Request(String(input), init)),
  });
  await client.connect(transport);
  return client;
}

beforeEach(() => wipeAllTables());

describe("dream MCP surface", () => {
  test("no auth ceremony: tools are callable immediately after initialize", async () => {
    const host = new DreamMcpHttpServer();
    const client = await connect(host);
    const tools = await client.listTools();
    const names = tools.tools.map(t => t.name).sort();
    expect(names).toEqual([
      "check_review_status",
      "create_daily_plan",
      "daily_plan_context",
      "get_survey",
      "list_records",
      "prioritize_context",
      "read_conversation_slice",
      "read_record",
      "record_create",
      "revise_record_create",
      "weekly_plan_context",
    ]);
    const survey = await client.callTool({ name: "get_survey", arguments: { model: "organized_goal" } });
    expect(text(survey)).toContain("Satellite sweep");
    await client.close();
  });

  test("record_create → review inbox → apply → read_record round trip", async () => {
    const host = new DreamMcpHttpServer();
    const client = await connect(host);

    const created = await client.callTool({
      name: "record_create",
      arguments: {
        summary_md: "goal rant digest: higher agency",
        operations: [
          { op: "create", tempId: "goal", model: "organized_goal", role: "central", fields: { title: "higher agency", description: "why it matters" } },
          { op: "create", tempId: "idea", model: "experiment_idea", role: "satellite", fields: { title: "tell a girl she's beautiful" } },
          { op: "link", relation: "idea_goal", from: "temp:idea", to: "temp:goal", description: "confidence reps" },
        ],
      },
    });
    const payload = JSON.parse(text(created)) as { status: string; marker_token: string };
    expect(payload.status).toBe("submitted_for_review");
    expect(payload.marker_token).toMatch(/^rc_/);

    // nothing exists yet — the membrane holds
    expect(db.select().from(organizedGoal).all()).toHaveLength(0);

    const pending = listRecordChangeSets("ready_for_review");
    expect(pending).toHaveLength(1);
    expect(applyRecordChangeSet(pending[0]!.id).ok).toBe(true);

    const goal = db.select().from(organizedGoal).all()[0]!;
    const read = await client.callTool({
      name: "read_record",
      arguments: { model: "organized_goal", lineage_id: goal.lineageId! },
    });
    const detail = JSON.parse(text(read)) as { relations: { ideas: { title: string; why: string }[] } };
    expect(detail.relations.ideas[0]!.title).toContain("beautiful");
    expect(detail.relations.ideas[0]!.why).toBe("confidence reps");

    const status = await client.callTool({ name: "check_review_status", arguments: { marker_token: payload.marker_token } });
    expect(JSON.parse(text(status)).status).toBe("applied");
    await client.close();
  });

  test("feedback loop: send back → check_review_status shows feedback → revise resubmits", async () => {
    const host = new DreamMcpHttpServer();
    const client = await connect(host);
    const created = await client.callTool({
      name: "record_create",
      arguments: {
        summary_md: "quick capture",
        operations: [{ op: "create", tempId: "i", model: "experiment_idea", role: "central", fields: { title: "try tennis" } }],
      },
    });
    const marker = (JSON.parse(text(created)) as { marker_token: string }).marker_token;

    const pending = listRecordChangeSets("ready_for_review")[0]!;
    rejectRecordChangeSet(pending.id, { feedback: "call it racket sports, not tennis", returnToDrafting: true });

    const status = JSON.parse(
      text(await client.callTool({ name: "check_review_status", arguments: { marker_token: marker } })),
    ) as { status: string; feedback: string };
    expect(status.status).toBe("drafting");
    expect(status.feedback).toContain("racket");

    const revised = await client.callTool({
      name: "revise_record_create",
      arguments: {
        marker_token: marker,
        summary_md: "quick capture (revised)",
        operations: [{ op: "create", tempId: "i", model: "experiment_idea", role: "central", fields: { title: "try racket sports" } }],
      },
    });
    expect(JSON.parse(text(revised)).status).toBe("resubmitted_for_review");
    expect(applyRecordChangeSet(pending.id).ok).toBe(true);
    expect(db.select().from(experimentIdea).all()[0]!.title).toContain("racket");
    await client.close();
  });

  test("list_records searches lineage heads for linking", async () => {
    const host = new DreamMcpHttpServer();
    const client = await connect(host);
    db.insert(organizedGoal).values({ title: "become more athletic", description: "movement", version: 1 }).run();
    const listed = await client.callTool({
      name: "list_records",
      arguments: { model: "organized_goal", query: "athletic movement" },
    });
    expect(JSON.parse(text(listed)).results).toHaveLength(1);
    await client.close();
  });
});
