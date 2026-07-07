import { beforeEach, describe, expect, test } from "bun:test";
import { db, wipeAllTables } from "../src/db";
import { goal, goalEvidence } from "../src/db/schema";
import { eq } from "drizzle-orm";
import { seedConfig } from "../src/services/config";
import {
  commitExperiment,
  createDraft,
  endExperiment,
  getPromptPackage,
  liveExperiment,
} from "../src/services/experiments";

const validDraft = {
  title: "Ship one rough song publicly",
  reasoning_md: "top goal lacks a lever; smallest first move",
  goal_ids: [] as string[],
  levers_json: { habit_changes: ["open Ableton after work"] },
  actions_json: [{ when: "I close my laptop after work", then: "open Ableton for 10 min" }],
  bandwidth: "normal" as const,
};

beforeEach(() => {
  wipeAllTables();
  seedConfig();
});

describe("experiment lifecycle", () => {
  test("draft paste returns field-level errors on invalid JSON shape", () => {
    const result = createDraft({ title: "", actions_json: [], bandwidth: "huge" });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(Object.keys(result.fieldErrors)).toContain("title");
    expect(Object.keys(result.fieldErrors)).toContain("actions_json");
    expect(Object.keys(result.fieldErrors)).toContain("bandwidth");
    expect(Object.keys(result.fieldErrors)).toContain("reasoning_md");
  });

  test("draft → commit → running; single-live invariant enforced", () => {
    const d1 = createDraft(validDraft);
    if (!d1.ok) throw new Error("draft failed");
    expect(d1.experiment.status).toBe("draft");
    expect(liveExperiment()).toBeNull(); // drafts are not live

    expect(commitExperiment(d1.experiment.id).ok).toBe(true);
    expect(liveExperiment()!.status).toBe("running");

    // A second draft can exist, but committing it is blocked.
    const d2 = createDraft({ ...validDraft, title: "second" });
    if (!d2.ok) throw new Error("draft failed");
    const blocked = commitExperiment(d2.experiment.id);
    expect(blocked.ok).toBe(false);
    expect(blocked.error).toContain("already live");

    // Prompt package refuses while live (§8.6.1).
    const pkg = getPromptPackage();
    expect(pkg.ok).toBe(false);

    // Ending unblocks both.
    expect(endExperiment(liveExperiment()!.id, "done", "it stuck").ok).toBe(true);
    expect(liveExperiment()).toBeNull();
    expect(getPromptPackage().ok).toBe(true);
    expect(commitExperiment(d2.experiment.id).ok).toBe(true);
  });

  test("compost is the same single call and writes blameless evidence to linked goals", () => {
    const g = db
      .insert(goal)
      .values({ title: "get lean", origin: "manual", status: "active" })
      .returning()
      .get();
    const d = createDraft({ ...validDraft, goal_ids: [g.id] });
    if (!d.ok) throw new Error("draft failed");
    commitExperiment(d.experiment.id);

    const result = endExperiment(d.experiment.id, "composted", undefined, "wrong size for this week");
    expect(result.ok).toBe(true);

    const ev = db.select().from(goalEvidence).where(eq(goalEvidence.goalId, g.id)).all();
    expect(ev).toHaveLength(1);
    expect(ev[0]!.note).toContain("composted");
    expect(ev[0]!.note).toContain("wrong size");
  });

  test("prompt package inlines the projected state", () => {
    db.insert(goal)
      .values({ title: "get lean", identityClause: "I am becoming lean", origin: "manual", status: "active" })
      .run();
    const pkg = getPromptPackage();
    expect(pkg.ok).toBe(true);
    if (!pkg.ok) throw new Error("unreachable");
    expect(pkg.markdown).toContain("experiment designer");
    expect(pkg.markdown).toContain("get lean");
    expect(pkg.markdown).toContain("MAX_ACTIVE_GOALS");
    expect(pkg.markdown).not.toContain("[STATE]"); // placeholder replaced
  });

  test("cannot end a draft or double-end", () => {
    const d = createDraft(validDraft);
    if (!d.ok) throw new Error("draft failed");
    expect(endExperiment(d.experiment.id, "done").ok).toBe(false);
    commitExperiment(d.experiment.id);
    expect(endExperiment(d.experiment.id, "done").ok).toBe(true);
    expect(endExperiment(d.experiment.id, "composted").ok).toBe(false);
  });
});
