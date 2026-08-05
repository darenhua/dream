import { beforeEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { db, wipeAllTables } from "../src/db";
import { chainRun, ifThenChain, weeklyPlan, winEntry } from "../src/db/schema";
import { DreamMcpHttpServer } from "../src/mcp/http";
import { applyRecordChangeSet, createRecordChangeSet } from "../src/services/recordChangeSets";
import { createWeeklyPlanV2, currentWeeklyPlanV2 } from "../src/services/weeklyPlanV2";

beforeEach(() => wipeAllTables());

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

function futureDate(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toLocaleDateString("en-CA");
}

function currentMonday(): string {
  const d = new Date();
  const dow = d.getDay();
  d.setDate(d.getDate() - ((dow + 6) % 7));
  return d.toLocaleDateString("en-CA");
}

function bootstrapPick() {
  const cs = createRecordChangeSet({
    summaryMd: "group + pick",
    operations: [
      { op: "create", tempId: "goal", model: "organized_goal", role: "satellite", fields: { title: "reclaim wanting" } },
      { op: "create", tempId: "group", model: "experiment_group", role: "central", fields: { title: "raw by saturday", theme: "ship the want" } },
      { op: "link", relation: "group_goal", from: "temp:group", to: "temp:goal", rank: 0 },
      { op: "pick", group: "temp:group", endDate: futureDate(56), reasoning: "the set must ship" },
    ],
  });
  const result = applyRecordChangeSet(cs.id);
  expect(result.ok).toBe(true);
}

const CHAIN_SPEC = {
  trigger: "I finish breakfast",
  purpose: "start practice without deciding",
  minimumVersion: "open the decks and play one song",
  rewardKind: "cold_drink",
  rewardText: "diet coke from the fridge",
  steps: [
    { kind: "starter", text: "put on headphones" },
    { kind: "warmup", text: "play yesterday's last song" },
    { kind: "core", text: "drill the bed→stem→song chain once" },
    { kind: "reward", text: "diet coke" },
  ],
};

function weeklyInput(overrides: Record<string, unknown> = {}) {
  return {
    weekOf: currentMonday(),
    direction: "prep only: arrive at the flight with a proven set",
    theme: "seal the gate",
    topOutcomes: ["a practiceable set, jam-verified, shipped to a friend"],
    description: "capacity is scattered, ~30-60 min a day",
    chainOps: [{ op: "create", tempId: "practice", chain: CHAIN_SPEC }],
    armedChains: ["temp:practice"],
    candidateMissions: ["close the crate", "drill the chain"],
    ...overrides,
  };
}

describe("weekly plan v2", () => {
  test("create is atomic: a bad armed ref rolls back plan AND chains", () => {
    bootstrapPick();
    expect(() => createWeeklyPlanV2(weeklyInput({ armedChains: ["temp:practice", "temp:ghost"] }))).toThrow(/ghost/);
    expect(db.select().from(weeklyPlan).all()).toHaveLength(0);
    expect(db.select().from(ifThenChain).all()).toHaveLength(0);
  });

  test("create builds chains, arms the set, parses views", () => {
    bootstrapPick();
    const plan = createWeeklyPlanV2(weeklyInput());
    expect(plan.chains).toHaveLength(1);
    expect(plan.chains[0]!.trigger).toBe("I finish breakfast");
    expect(plan.topOutcomes).toHaveLength(1);
    expect(db.select().from(ifThenChain).all()).toHaveLength(1);
  });

  test("currentWeeklyPlanV2 is exact-week: a stale past week is never 'current'", () => {
    bootstrapPick();
    const lastMonday = (() => {
      const d = new Date(`${currentMonday()}T12:00:00`);
      d.setDate(d.getDate() - 7);
      return d.toLocaleDateString("en-CA");
    })();
    createWeeklyPlanV2(weeklyInput({ weekOf: lastMonday }));
    // last week's plan answers only for last week's dates…
    expect(currentWeeklyPlanV2(lastMonday)?.weekOf).toBe(lastMonday);
    // …never for this week: no plan for the current week IS the fact.
    expect(currentWeeklyPlanV2()).toBeNull();
  });
});

describe("MCP planning trajectory (weekly → daily → wins → doing mode)", () => {
  test("full loop over streamable HTTP", async () => {
    bootstrapPick();
    const host = new DreamMcpHttpServer();
    const client = await connect(host);

    // weekly session: planning opens directly — no review gate anywhere (WO-0)
    const weeklyCtx = JSON.parse(text(await client.callTool({ name: "weekly_plan_context", arguments: {} })));
    expect(weeklyCtx.reviewFirst).toBeUndefined();
    expect(JSON.stringify(weeklyCtx)).not.toMatch(/unreviewed/i);
    expect(weeklyCtx.chainLibrary).toHaveLength(0);
    const weekly = JSON.parse(
      text(await client.callTool({ name: "create_weekly_plan", arguments: weeklyInput() as never })),
    );
    expect(weekly.status).toBe("created");

    // daily session: selection from the armed menu
    const today = new Date().toLocaleDateString("en-CA");
    const dailyCtx = JSON.parse(text(await client.callTool({ name: "daily_plan_context", arguments: { date: today } })));
    expect(dailyCtx.week.armedChains).toHaveLength(1);
    const chainLineageId = dailyCtx.week.armedChains[0].lineageId as string;
    const daily = JSON.parse(
      text(
        await client.callTool({
          name: "create_daily_plan",
          arguments: {
            date: today,
            theme: "ship the want",
            description: "energy mid, nerves high",
            topPriority: "one verified chain rep",
            firstDomino: "put on headphones",
            minimumViableDay: "one song played on the decks",
            selectedChains: [{ chainLineageId }],
          },
        }),
      ),
    );
    expect(daily.status).toBe("created");
    expect(db.select().from(chainRun).all()).toHaveLength(1);

    // review: conversational wins land in the ledger
    const wins = JSON.parse(
      text(
        await client.callTool({
          name: "record_wins",
          arguments: {
            entries: [
              { date: today, kind: "courage", text: "texted a friend for their favourite song" },
              { date: today, kind: "identity", text: "acted like someone who ships" },
            ],
          },
        }),
      ),
    );
    expect(wins.count).toBe(2);
    expect(db.select().from(winEntry).all()).toHaveLength(2);

    // doing mode + one-pagers
    const doing = JSON.parse(text(await client.callTool({ name: "current_task_context", arguments: {} })));
    expect(doing.plan.topPriority).toBe("one verified chain rep");
    expect(doing.week.direction).toContain("proven set");

    const appended = JSON.parse(
      text(
        await client.callTool({
          name: "append_plan_doc",
          arguments: { scope: "weekly", ref_id: weekly.plan.id, content_md: "## set design\nlean on the bed: fewer transitions" },
        }),
      ),
    );
    expect(appended.status).toBe("appended");
    const readBack = JSON.parse(
      text(await client.callTool({ name: "read_plan_doc", arguments: { scope: "weekly", ref_id: weekly.plan.id } })),
    );
    expect(readBack.doc.contentMd).toContain("lean on the bed");

    // old daily shape is rejected — chains replaced items
    const legacy = await client.callTool({
      name: "create_daily_plan",
      arguments: {
        date: futureDate(1),
        theme: "x",
        description: "y",
        items: [{ kind: "todo", text: "old shape" }],
      } as never,
    });
    expect((legacy as { isError?: boolean }).isError).toBe(true);

    await client.close();
  });
});
