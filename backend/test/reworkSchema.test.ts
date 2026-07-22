import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../src/db";
import {
  conversationRecordLink,
  conversation,
  dailyPlan,
  dailyPlanItem,
  experimentIdea,
  groupIdea,
  ideaGoal,
  leisureActivity,
  lineageParent,
  organizedGoal,
  patternOfBehavior,
  task,
} from "../src/db/schema";

// Phase 1 smoke: the rework tables and versioning columns round-trip.
describe("rework schema foundation", () => {
  test("versioned content rows and lineage-referencing relationships round-trip", () => {
    const goal = db
      .insert(organizedGoal)
      .values({ title: "higher agency", description: "what it means to me", version: 1 })
      .returning()
      .get();
    db.update(organizedGoal).set({ lineageId: goal.id }).where(eq(organizedGoal.id, goal.id)).run();

    const idea = db
      .insert(experimentIdea)
      .values({ title: "try tennis", description: "one-liner is fine", version: 1 })
      .returning()
      .get();
    db.update(experimentIdea).set({ lineageId: idea.id }).where(eq(experimentIdea.id, idea.id)).run();

    db.insert(ideaGoal)
      .values({ ideaLineageId: idea.id, goalLineageId: goal.id, description: "racket sports stick" })
      .run();

    const v2 = db
      .insert(experimentIdea)
      .values({ title: "try tennis", description: "weekly lesson", lineageId: idea.id, version: 2, prevVersionId: idea.id })
      .returning()
      .get();
    expect(v2.lineageId).toBe(idea.id);

    // the idea_goal relationship follows the lineage without any rewrite
    const links = db.select().from(ideaGoal).where(eq(ideaGoal.ideaLineageId, idea.id)).all();
    expect(links).toHaveLength(1);

    db.insert(lineageParent)
      .values({ childType: "experiment_idea", childLineageId: v2.id, parentType: "experiment_idea", parentVersionId: idea.id })
      .run();
    db.insert(groupIdea).values({ groupLineageId: crypto.randomUUID(), ideaLineageId: idea.id }).run();
  });

  test("plans, items, tasks, patterns, leisure insert with timestamp-derived state", () => {
    const pattern = db
      .insert(patternOfBehavior)
      .values({ title: "shame spiral", description: "trigger: comparison; coping: going dark", version: 1 })
      .returning()
      .get();
    db.insert(leisureActivity)
      .values({
        title: "morning matcha",
        description: "for slow mornings when work dread is high",
        counteractsPatternLineageId: pattern.id,
        version: 1,
      })
      .run();
    const errand = db.insert(task).values({ title: "book dermatologist", deadlineDate: "2026-09-01", version: 1 }).returning().get();
    expect(errand.doneAt).toBeNull();

    const plan = db.insert(dailyPlan).values({ date: "2026-07-21", theme: "survive the review, then be unreachable" }).returning().get();
    const item = db
      .insert(dailyPlanItem)
      .values({ dailyPlanId: plan.id, kind: "leisure", text: "matcha block 7:40" })
      .returning()
      .get();
    db.update(dailyPlanItem).set({ doneAt: new Date().toISOString() }).where(eq(dailyPlanItem.id, item.id)).run();
    expect(db.select().from(dailyPlanItem).where(eq(dailyPlanItem.dailyPlanId, plan.id)).all()[0]!.doneAt).not.toBeNull();
  });

  test("conversation_record_link stitches a record to a conversation slice", () => {
    const convo = db
      .insert(conversation)
      .values({ externalId: crypto.randomUUID(), rawJson: "{}", title: "agency rant" })
      .returning()
      .get();
    db.insert(conversationRecordLink)
      .values({
        conversationId: convo.id,
        markerToken: "rc_abc123",
        sliceEndIdx: 41,
        recordType: "organized_goal",
        recordVersionId: crypto.randomUUID(),
        role: "created_central",
      })
      .run();
    const links = db.select().from(conversationRecordLink).where(eq(conversationRecordLink.conversationId, convo.id)).all();
    expect(links[0]!.role).toBe("created_central");
  });
});
