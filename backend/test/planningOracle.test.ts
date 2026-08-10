import { beforeEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { wipeAllTables } from "../src/db";
import { addDaysStr, mondayOf, todayLocal } from "../src/lib/time";
import { DreamMcpHttpServer } from "../src/mcp/http";
import "../src/services/planningFlowWiring";
import { beginPlanningFlow, savePlan } from "../src/services/planningFlows";
import {
  interpretPlanningState,
  renderBriefing,
  type PlanningFacts,
} from "../src/services/planningOracle";

// WO-1 acceptance: the oracle interpretation unit fixtures. The pure seams
// (interpret + render) run against hand-built facts — zero DB — across the
// state matrix, then two DB-backed smoke tests cover the wiring.

// ── Fixture builder ────────────────────────────────────────────────────────
// Baseline: Tuesday Aug 4 2026, 10:00, era with a real story, this week
// planned with chains, tomorrow planless. Fixtures override from here.

const STORY = "x".repeat(400); // comfortably past the thin threshold

function facts(overrides: Partial<PlanningFacts> = {}): PlanningFacts {
  return {
    now: { date: "2026-08-04", time: "10:00", minutes: 600, timezone: "America/Los_Angeles", dayOfWeek: 2 },
    era: {
      focusId: "focus-1",
      theme: "Ten weeks of audacity",
      story: STORY,
      periodStart: "2026-08-04",
      periodEnd: "2026-10-12",
      expired: false,
    },
    weekly: {
      targetWeekStart: "2026-08-03",
      plan: { id: "wk-1", weekOf: "2026-08-03", theme: "take up space", chainCount: 3 },
      priorThemes: [{ weekOf: "2026-07-27", theme: "seal the gate" }],
      priorWeekChains: [{ lineageId: "ch-1", trigger: "I finish brushing my teeth", status: "active" }],
    },
    daily: {
      today: { date: "2026-08-04", plan: { id: "dp-1", theme: "ship the want" } },
      tomorrow: { date: "2026-08-05", plan: null },
      priorThemes: [{ date: "2026-08-03", theme: "ship the want" }],
    },
    chains: { active: 3, draft: 0, retired: 1 },
    ...overrides,
  };
}

const NO_SHAME = /\bwins?\b|unreviewed|undone|unlogged|planless|streak|missed|behind|nothing came of/i;

function run(f: PlanningFacts, userRequest?: string) {
  const interp = interpretPlanningState(f, userRequest);
  return { interp, md: renderBriefing(interp) };
}

describe("oracle state matrix", () => {
  test("no-era: everything routes to monthly-create, warmly", () => {
    const { interp, md } = run(facts({ era: null, chains: { active: 0, draft: 0, retired: 0 } }));
    expect(interp.candidates[0]).toMatchObject({ horizon: "monthly", operation: "create" });
    expect(interp.openingMove.kind).toBe("parent-route");
    expect(md).toContain("No monthly era.");
    expect(md).toContain("that's the first thing to make");
    // §6.4-derivable: state + a rant prompt pointed at what the era is for
    expect(md).toContain("what the next stretch is for");
  });

  test("no-era + daily intent: blocked, routed forward — never an error", () => {
    const { interp, md } = run(facts({ era: null }), "plan tomorrow");
    expect(interp.blockedBy).toEqual({ horizon: "daily", missingParent: "monthly" });
    expect(interp.openingMove.kind).toBe("parent-route");
    expect(md).toContain("Want to?");
  });

  test("expired era routes to the next era — framed as closed, never as failure", () => {
    const { interp, md } = run(
      facts({
        era: {
          focusId: "focus-0",
          theme: "raw by saturday",
          story: STORY,
          periodStart: "2026-06-01",
          periodEnd: "2026-08-01",
          expired: true,
        },
      }),
    );
    expect(interp.candidates[0]).toMatchObject({ horizon: "monthly", operation: "create" });
    expect(md).toContain("closed");
    expect(md).not.toMatch(NO_SHAME);
  });

  test("era, no weekly: weekly-create with the carryover check up front", () => {
    const { interp, md } = run(facts({ weekly: { ...facts().weekly, plan: null } }));
    expect(interp.candidates[0]).toMatchObject({ horizon: "weekly", operation: "create", targetPeriod: "2026-08-03" });
    expect(interp.openingMove.kind).toBe("single-offer");
    expect(md).toContain("no plan yet");
    expect(md).toContain("last week's chains");
  });

  test("era + weekly, no daily: the §6.5-shaped single-question offer", () => {
    const { interp, md } = run(facts());
    expect(interp.dailyTarget).toEqual({ date: "2026-08-05", label: "tomorrow" });
    expect(interp.candidates[0]).toMatchObject({ horizon: "daily", operation: "create" });
    expect(interp.openingMove.kind).toBe("single-offer");
    expect(md).toContain("you don't have a plan for tomorrow yet. Want to make one?");
    expect(md).toContain("Cheap version");
    expect(md).toContain("more in you than that");
  });

  test("thin monthly: weekly proceeds AND deepens — degrade, never refuse", () => {
    const { interp, md } = run(
      facts({
        era: { ...facts().era!, story: "just a theme" },
        weekly: { ...facts().weekly, plan: null },
      }),
    );
    expect(interp.parentSubstance.monthly).toBe("thin");
    expect(interp.blockedBy).toBeNull();
    expect(interp.candidates[0]).toMatchObject({ horizon: "weekly", operation: "create" });
    expect(md).toContain("go a little deeper");
  });

  test("thin weekly (theme-only, zero chains): daily proceeds", () => {
    const { interp } = run(
      facts({ weekly: { ...facts().weekly, plan: { id: "wk-1", weekOf: "2026-08-03", theme: "take up space", chainCount: 0 } } }),
    );
    expect(interp.parentSubstance.weekly).toBe("thin");
    expect(interp.blockedBy).toBeNull();
    expect(interp.candidates[0]).toMatchObject({ horizon: "daily", operation: "create" });
    expect(interp.candidates[0]!.reason).toContain("theme-only");
  });

  test("11:58pm: very-late energy note, session kept short", () => {
    const { interp, md } = run(facts({ now: { ...facts().now, time: "23:58", minutes: 23 * 60 + 58 } }));
    expect(interp.energy.lateness).toBe("very-late");
    expect(md).toContain("keep this one short");
  });

  test("after midnight: today-vs-tomorrow ambiguity is asked, kindly", () => {
    const { interp } = run(facts({ now: { ...facts().now, date: "2026-08-05", time: "00:30", minutes: 30, dayOfWeek: 3 } }));
    expect(interp.energy.lateness).toBe("after-midnight");
    expect(interp.ambiguities.some(a => a.kind === "today-vs-tomorrow")).toBe(true);
  });

  test("plan already exists for target: update-vs-fresh menu, never silent overwrite", () => {
    const { interp, md } = run(
      facts({
        daily: { ...facts().daily, tomorrow: { date: "2026-08-05", plan: { id: "dp-2", theme: "audacity reps" } } },
      }),
    );
    expect(interp.ambiguities.some(a => a.kind === "update-vs-fresh")).toBe(true);
    expect(interp.openingMove.kind).toBe("menu");
    expect(md).toContain('"audacity reps"');
    expect(md).toContain("revise it, or leave it alone?");
  });

  test("explicit intent re-ranks: 'the week' wins over the daily default", () => {
    const { interp } = run(
      facts({
        daily: { ...facts().daily, tomorrow: { date: "2026-08-05", plan: { id: "dp-2", theme: "audacity reps" } } },
      }),
      "I want to revise the week",
    );
    expect(interp.candidates[0]!.horizon).toBe("weekly");
  });

  test("library at the global 5-cap: conflict surfaced, never resolved", () => {
    const { interp, md } = run(facts({ chains: { active: 5, draft: 0, retired: 0 } }));
    expect(interp.conflicts).toHaveLength(1);
    expect(md).toContain("Heads up");
    expect(md).toContain("3 per zone");
  });

  test("every fixture: no shame, no wins, no review — and speakable in ~15s", () => {
    const fixtures: [PlanningFacts, string?][] = [
      [facts()],
      [facts({ era: null })],
      [facts({ weekly: { ...facts().weekly, plan: null } })],
      [facts({ era: { ...facts().era!, expired: true } })],
      [facts({ now: { ...facts().now, time: "23:58", minutes: 23 * 60 + 58 } })],
      [facts({ daily: { ...facts().daily, tomorrow: { date: "2026-08-05", plan: { id: "d", theme: "t" } } } })],
    ];
    for (const [f, req] of fixtures) {
      const { md } = run(f, req);
      expect(md).not.toMatch(NO_SHAME);
      expect(md.split(/\s+/).length).toBeLessThanOrEqual(170); // ~15s spoken body + rules
      expect(md).toContain("# Dream briefing");
      expect(md).toContain("## Your opening move");
      expect(md).toContain("Likely:");
    }
  });
});

// ── DB-backed smoke tests through the MCP surface ──────────────────────────

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

function bootstrapEraAndWeek() {
  const today = todayLocal();
  const mFlow = beginPlanningFlow({ confirmed_intent: "create the monthly era" });
  if (!mFlow.ok) throw new Error(mFlow.markdown);
  const mSave = savePlan({
    workflow_session_id: mFlow.structured.session_id as string,
    request_id: crypto.randomUUID(),
    user_confirmed_save: true,
    plan: {
      title: "Ten weeks of audacity",
      periodStart: today,
      periodEnd: addDaysStr(today, 70),
      theme: "audacity, skill, talent",
      story: "New city, nobody knows me. ".repeat(12).trim(),
      promises: [],
    },
  });
  if (!mSave.ok) throw new Error(mSave.markdown);
  const week = mondayOf(today);
  const wFlow = beginPlanningFlow({ confirmed_intent: "plan the week" });
  if (!wFlow.ok) throw new Error(wFlow.markdown);
  const wSave = savePlan({
    workflow_session_id: wFlow.structured.session_id as string,
    request_id: crypto.randomUUID(),
    user_confirmed_save: true,
    plan: {
      weekStart: week,
      weekEnd: addDaysStr(week, 6),
      theme: "take up space",
      chains: [
        {
          cueText: "I finish brushing my teeth",
          friendlyCueTitle: "Brush your teeth!",
          zone: "before_work",
          links: ["step outside", "text my family"],
          reward: "pre-set water bottle",
          kind: "habit",
          carryover: "new",
        },
      ],
      leisurePool: [],
      datedEvents: [],
      doOnce: [],
    },
  });
  if (!wSave.ok) throw new Error(wSave.markdown);
}

describe("get_planning_context over MCP", () => {
  test("empty DB: briefing routes to monthly-create, markdown + structured dual", async () => {
    const host = new DreamMcpHttpServer();
    const client = await connect(host);
    const result = (await client.callTool({ name: "get_planning_context", arguments: {} })) as {
      structuredContent?: Record<string, unknown>;
    };
    const md = text(result);
    expect(md).toContain("# Dream briefing");
    expect(md).toContain("No monthly era.");
    expect(md).toContain("that's the first thing to make");
    const structured = result.structuredContent as { openingMove: { kind: string }; candidates: { horizon: string }[] };
    expect(structured.openingMove.kind).toBe("parent-route");
    expect(structured.candidates[0]!.horizon).toBe("monthly");
    await client.close();
  });

  test("era + weekly, no daily: single-question daily offer", async () => {
    bootstrapEraAndWeek();
    const host = new DreamMcpHttpServer();
    const client = await connect(host);
    const result = (await client.callTool({ name: "get_planning_context", arguments: { user_request: "hey" } })) as {
      structuredContent?: Record<string, unknown>;
    };
    const md = text(result);
    const structured = result.structuredContent as {
      openingMove: { kind: string };
      candidates: { horizon: string; operation: string }[];
    };
    expect(structured.candidates[0]).toMatchObject({ horizon: "daily", operation: "create" });
    expect(structured.openingMove.kind).toBe("single-offer");
    expect(md).toContain("Want to make one?");
    expect(md).not.toMatch(NO_SHAME);
    await client.close();
  });
});
