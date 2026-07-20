import { asc, eq, inArray } from "drizzle-orm";
import { db } from "../db";
import {
  calendarEvent,
  conversation,
  conversationRecordLink,
  environmentItem,
  experimentGroupGoal,
  goalHabit,
  goalPattern,
  groupHabit,
  groupIdea,
  ideaGoal,
  ideaProject,
  lineageParent,
  task,
} from "../db/schema";
import { lineageHead, modelTable, searchModel, type VersionedModel } from "./records";

// read_record's typed pull-downs (SPEC §8a): reading is an explicit user act;
// each model pulls its own relation web, with conversation slices as a
// second-level zoom-in.

function headSummary(model: VersionedModel, lineageId: string) {
  const head = lineageHead(model, lineageId);
  if (!head) return { lineageId, model, title: "(missing)", description: null };
  return {
    lineageId,
    model,
    title: (head as { title: string }).title,
    description: (head as { description: string | null }).description,
    version: head.version ?? 1,
  };
}

export function listRecords(model: VersionedModel, query?: string, limit = 50) {
  return searchModel(model, query ?? "", limit);
}

const ALL_MODELS: VersionedModel[] = [
  "organized_goal",
  "habit",
  "environment_item",
  "project",
  "experiment_group",
  "pattern_of_behavior",
  "experiment_idea",
  "task",
  "leisure_activity",
];

/** Step 1 of reading: one search across every model ("working out" → the
 * matching goals, habits, ideas, … together), so the user can pick the record
 * to actually read. */
export function searchAllRecords(query: string, limitPerModel = 8) {
  const results: Record<string, ReturnType<typeof searchModel>> = {};
  for (const model of ALL_MODELS) {
    const hits = searchModel(model, query, limitPerModel);
    if (hits.length) results[model] = hits;
  }
  return results;
}

/** Version chain + branch parentage + conversation provenance for a lineage. */
function lineageEnvelope(model: VersionedModel, lineageId: string) {
  const table = modelTable(model);
  const versions = db.select().from(table).where(eq(table.lineageId, lineageId)).orderBy(asc(table.version)).all();
  if (!versions.length) return null;
  const versionIds = versions.map(v => v.id);
  const parents = db
    .select()
    .from(lineageParent)
    .where(eq(lineageParent.childLineageId, lineageId))
    .all()
    .map(row => ({ parentType: row.parentType, parentVersionId: row.parentVersionId }));
  const children = db
    .select()
    .from(lineageParent)
    .where(inArray(lineageParent.parentVersionId, versionIds))
    .all()
    .map(row => ({ childType: row.childType, childLineageId: row.childLineageId }));
  const slices = db
    .select({
      conversationId: conversationRecordLink.conversationId,
      sliceEndIdx: conversationRecordLink.sliceEndIdx,
      role: conversationRecordLink.role,
      title: conversation.title,
      date: conversation.sourceUpdatedAt,
    })
    .from(conversationRecordLink)
    .innerJoin(conversation, eq(conversationRecordLink.conversationId, conversation.id))
    .where(inArray(conversationRecordLink.recordVersionId, versionIds))
    .all();
  return { versions, head: versions[versions.length - 1]!, parents, children, conversationSlices: slices };
}

export function readRecord(model: VersionedModel, lineageId: string) {
  const envelope = lineageEnvelope(model, lineageId);
  if (!envelope) return null;
  const relations: Record<string, unknown> = {};

  switch (model) {
    case "organized_goal": {
      relations.habits = db
        .select()
        .from(goalHabit)
        .where(eq(goalHabit.goalId, lineageId))
        .all()
        .map(row => ({ ...headSummary("habit", row.habitId), why: row.description }));
      relations.patterns = db
        .select()
        .from(goalPattern)
        .where(eq(goalPattern.goalLineageId, lineageId))
        .all()
        .map(row => headSummary("pattern_of_behavior", row.patternLineageId));
      relations.ideas = db
        .select()
        .from(ideaGoal)
        .where(eq(ideaGoal.goalLineageId, lineageId))
        .all()
        .map(row => ({ ...headSummary("experiment_idea", row.ideaLineageId), why: row.description }));
      relations.groups = db
        .select()
        .from(experimentGroupGoal)
        .where(eq(experimentGroupGoal.organizedGoalId, lineageId))
        .all()
        .map(row => ({ ...headSummary("experiment_group", row.experimentGroupId), rank: row.rank }));
      break;
    }
    case "habit": {
      relations.goals = db
        .select()
        .from(goalHabit)
        .where(eq(goalHabit.habitId, lineageId))
        .all()
        .map(row => ({ ...headSummary("organized_goal", row.goalId), why: row.description }));
      relations.environments = db
        .select()
        .from(environmentItem)
        .where(eq(environmentItem.habitLineageId, lineageId))
        .all()
        .map(row => ({ lineageId: row.lineageId ?? row.id, title: row.title, effect: row.effect, description: row.description }));
      relations.eliminatingGroups = db
        .select()
        .from(groupHabit)
        .where(eq(groupHabit.habitLineageId, lineageId))
        .all()
        .map(row => headSummary("experiment_group", row.groupLineageId));
      break;
    }
    case "environment_item": {
      const head = envelope.head as typeof environmentItem.$inferSelect;
      relations.habit = head.habitLineageId ? headSummary("habit", head.habitLineageId) : null;
      break;
    }
    case "project": {
      relations.ideas = db
        .select()
        .from(ideaProject)
        .where(eq(ideaProject.projectLineageId, lineageId))
        .all()
        .map(row => headSummary("experiment_idea", row.ideaLineageId));
      break;
    }
    case "experiment_idea": {
      relations.goals = db
        .select()
        .from(ideaGoal)
        .where(eq(ideaGoal.ideaLineageId, lineageId))
        .all()
        .map(row => ({ ...headSummary("organized_goal", row.goalLineageId), why: row.description }));
      relations.groups = db
        .select()
        .from(groupIdea)
        .where(eq(groupIdea.ideaLineageId, lineageId))
        .all()
        .map(row => ({ ...headSummary("experiment_group", row.groupLineageId), doneAt: row.doneAt }));
      relations.tasks = db
        .select()
        .from(task)
        .where(eq(task.experimentIdeaLineageId, lineageId))
        .all()
        .map(row => ({ lineageId: row.lineageId ?? row.id, title: row.title, deadlineDate: row.deadlineDate, doneAt: row.doneAt }));
      relations.projects = db
        .select()
        .from(ideaProject)
        .where(eq(ideaProject.ideaLineageId, lineageId))
        .all()
        .map(row => headSummary("project", row.projectLineageId));
      break;
    }
    case "experiment_group": {
      relations.memberIdeas = db
        .select()
        .from(groupIdea)
        .where(eq(groupIdea.groupLineageId, lineageId))
        .all()
        .map(row => ({ ...headSummary("experiment_idea", row.ideaLineageId), doneAt: row.doneAt, note: row.note }));
      relations.goalSet = db
        .select()
        .from(experimentGroupGoal)
        .where(eq(experimentGroupGoal.experimentGroupId, lineageId))
        .all()
        .sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99))
        .map(row => ({ ...headSummary("organized_goal", row.organizedGoalId), rank: row.rank }));
      relations.eliminatingHabits = db
        .select()
        .from(groupHabit)
        .where(eq(groupHabit.groupLineageId, lineageId))
        .all()
        .map(row => headSummary("habit", row.habitLineageId));
      break;
    }
    case "task": {
      const head = envelope.head as typeof task.$inferSelect;
      relations.idea = head.experimentIdeaLineageId ? readIdeaWithGoals(head.experimentIdeaLineageId) : null;
      relations.calendarEvents = db
        .select()
        .from(calendarEvent)
        .where(eq(calendarEvent.entityId, lineageId))
        .all()
        .map(row => ({ title: row.title, startAt: row.startAt, endAt: row.endAt, status: row.status }));
      break;
    }
    case "pattern_of_behavior": {
      relations.goals = db
        .select()
        .from(goalPattern)
        .where(eq(goalPattern.patternLineageId, lineageId))
        .all()
        .map(row => headSummary("organized_goal", row.goalLineageId));
      break;
    }
    case "leisure_activity": {
      const head = envelope.head as { counteractsPatternLineageId: string | null };
      relations.counteractsPattern = head.counteractsPatternLineageId
        ? headSummary("pattern_of_behavior", head.counteractsPatternLineageId)
        : null;
      break;
    }
  }

  // Step 2 pulls up the rant: inline the originating slice text (the
  // conversation that created this record), when its export was imported.
  const originating = envelope.conversationSlices.find(s => s.role === "created_central")
    ?? envelope.conversationSlices.find(s => s.role === "created_satellite");
  const rant = originating ? readConversationSlice(originating.conversationId, originating.sliceEndIdx) : null;

  return { model, lineageId, ...envelope, relations, rant };
}

function readIdeaWithGoals(ideaLineageId: string) {
  const summary = headSummary("experiment_idea", ideaLineageId);
  const goals = db
    .select()
    .from(ideaGoal)
    .where(eq(ideaGoal.ideaLineageId, ideaLineageId))
    .all()
    .map(row => ({ ...headSummary("organized_goal", row.goalLineageId), why: row.description }));
  return { ...summary, goals };
}

/** Second-level zoom-in: the actual conversation slice text behind a record. */
export function readConversationSlice(conversationId: string, sliceEndIdx?: number | null) {
  const row = db.select().from(conversation).where(eq(conversation.id, conversationId)).get();
  if (!row?.contentJson) return null;
  const messages = JSON.parse(row.contentJson) as { role: string; content: string }[];
  const slice = sliceEndIdx != null ? messages.slice(0, sliceEndIdx) : messages;
  return { conversationId, title: row.title, date: row.sourceUpdatedAt, messages: slice };
}
