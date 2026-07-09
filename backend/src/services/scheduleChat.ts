import { and, asc, eq } from "drizzle-orm";
import { db } from "../db";
import { calendarEvent, chatMessage, chatSession, experimentTask, habit } from "../db/schema";
import { SchedulePlanTurn, type SchedulePlanT } from "../domain/schemas";
import { runChatTurn } from "./agentRunner";
import { isConnected, pushEvent } from "./calendarSync";
import { emit } from "./events";
import { cancelScheduling, commitPlan } from "./experiments";
import { freeTimeReport } from "./promptGenerator";
import { scheduleContextMd } from "./projector";

// The in-dashboard scheduling conversation: a backend agent that sees the
// picked candidate, current state, and real free time, and converges on ONE
// concrete plan the user commits.

// The opener is implicit — shown to the agent, never stored or displayed.
const OPENER =
  "The session just opened. Propose an initial plan sized conservatively, or ask me what you need to know first (bandwidth, preferences).";

export function findOpenSession(experimentId: string) {
  const session = db
    .select()
    .from(chatSession)
    .where(and(eq(chatSession.experimentId, experimentId), eq(chatSession.status, "open")))
    .get();
  return session ? getSession(session.id) : null;
}

export function getSession(sessionId: string) {
  const session = db.select().from(chatSession).where(eq(chatSession.id, sessionId)).get();
  if (!session) return null;
  const messages = db
    .select()
    .from(chatMessage)
    .where(eq(chatMessage.sessionId, sessionId))
    .orderBy(asc(chatMessage.createdAt))
    .all();
  return {
    ...session,
    plan: session.planJson ? (JSON.parse(session.planJson) as SchedulePlanT) : null,
    messages,
  };
}

function history(sessionId: string): { role: "user" | "assistant"; content: string }[] {
  const rows = db
    .select()
    .from(chatMessage)
    .where(eq(chatMessage.sessionId, sessionId))
    .orderBy(asc(chatMessage.createdAt))
    .all();
  return [{ role: "user" as const, content: OPENER }, ...rows.map(m => ({ role: m.role, content: m.content }))];
}

async function agentTurn(session: typeof chatSession.$inferSelect) {
  const system = scheduleContextMd(session.experimentId!, await freeTimeReport());
  const run = await runChatTurn("schedule_agent", system, history(session.id), SchedulePlanTurn, {
    trigger: "manual",
  });
  if (run.status !== "ok" || !run.output) {
    return { ok: false as const, error: run.error ?? "schedule agent failed" };
  }
  db.insert(chatMessage)
    .values({
      sessionId: session.id,
      role: "assistant",
      content: run.output.message_to_user,
      agentRunId: run.runId,
    })
    .run();
  db.update(chatSession)
    .set({ planJson: JSON.stringify(run.output.plan) })
    .where(eq(chatSession.id, session.id))
    .run();
  return { ok: true as const };
}

// First agent turn after pick — the agent opens the conversation.
export async function openingTurn(sessionId: string) {
  const session = db.select().from(chatSession).where(eq(chatSession.id, sessionId)).get();
  if (!session) return { ok: false as const, error: "session not found" };
  if (session.status !== "open") return { ok: false as const, error: `session is ${session.status}` };
  return agentTurn(session);
}

export async function postMessage(sessionId: string, text: string) {
  const session = db.select().from(chatSession).where(eq(chatSession.id, sessionId)).get();
  if (!session) return { ok: false as const, error: "session not found" };
  if (session.status !== "open") return { ok: false as const, error: `session is ${session.status}` };
  db.insert(chatMessage).values({ sessionId, role: "user", content: text }).run();
  return agentTurn(session);
}

// The user commits the plan: experiment → running + habits/tasks/experiences
// created (commitPlan), then everything schedulable lands on the calendar.
export async function confirmSession(sessionId: string) {
  const session = db.select().from(chatSession).where(eq(chatSession.id, sessionId)).get();
  if (!session) return { ok: false as const, error: "session not found" };
  if (session.status !== "open") return { ok: false as const, error: `session is ${session.status}` };
  if (!session.planJson) return { ok: false as const, error: "no plan to commit yet — chat first" };
  const plan = JSON.parse(session.planJson) as SchedulePlanT;

  const result = commitPlan(session.experimentId!, plan);
  if (!result.ok) return { ok: false as const, error: result.error };

  db.update(chatSession).set({ status: "committed" }).where(eq(chatSession.id, sessionId)).run();

  // Calendar rows for everything schedulable; pushed to GCal when connected.
  const eventIds = createCalendarRows(session.experimentId!, plan);
  let pushed = 0;
  if (isConnected()) {
    for (const id of eventIds) {
      try {
        await pushEvent(id);
        pushed++;
      } catch (e) {
        emit("calendar_event", id, "push_failed", { error: e instanceof Error ? e.message : String(e) });
      }
    }
  }
  emit("chat_session", sessionId, "session_committed", { events: eventIds.length, pushed });
  return { ok: true as const, experiment: result.experiment, calendarEvents: eventIds.length, pushed };
}

function createCalendarRows(experimentId: string, plan: SchedulePlanT): string[] {
  const ids: string[] = [];
  const tasks = db
    .select()
    .from(experimentTask)
    .where(eq(experimentTask.experimentId, experimentId))
    .all();
  for (const t of plan.tasks) {
    const task = tasks.find(row => row.title === t.title);
    if (!task) continue;
    const row = db
      .insert(calendarEvent)
      .values({
        entityType: "experiment_task",
        entityId: task.id,
        title: t.title,
        startAt: t.start,
        endAt: t.end,
        blockStyle: "task",
      })
      .returning()
      .get();
    ids.push(row.id);
  }
  const habits = db.select().from(habit).where(eq(habit.experimentId, experimentId)).all();
  for (const h of plan.habit_blocks) {
    const habitRow = habits.find(row => row.title === h.title);
    if (!habitRow) continue;
    const start = new Date(h.first_occurrence);
    const end = new Date(start.getTime() + h.duration_minutes * 60_000);
    const row = db
      .insert(calendarEvent)
      .values({
        entityType: "habit",
        entityId: habitRow.id,
        title: h.title,
        startAt: start.toISOString(),
        endAt: end.toISOString(),
        rrule: h.rrule,
        blockStyle: "experiment", // building habits are visually distinct until they graduate
      })
      .returning()
      .get();
    ids.push(row.id);
  }
  return ids;
}

// Bailing out is free: session cancelled, experiment back to queued.
export function cancelSession(sessionId: string) {
  const session = db.select().from(chatSession).where(eq(chatSession.id, sessionId)).get();
  if (!session) return { ok: false, error: "session not found" };
  if (session.status !== "open") return { ok: false, error: `session is ${session.status}` };
  return cancelScheduling(session.experimentId!);
}
