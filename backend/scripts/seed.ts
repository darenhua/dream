// Seed a scratch database with realistic fixture data so any environment
// (fresh dev checkout, preview slot, nuked staging) demos end-to-end:
// ranked organized goals, registry habits, experiment ideas with why-links,
// and an open deadline task for the daily-nag path. Refuses a non-empty DB —
// it can never run against real data by accident. Weekly/daily plans and the
// monthly pick are deliberately NOT seeded: they carry invariants that belong
// to the real flows (prioritize/plan through the MCP).
//
// Usage: bun run seed            (backend/, honors DB_PATH)
import { count } from "drizzle-orm";
import { db } from "../src/db";
import { experimentIdea, habit, ideaGoal, organizedGoal, task } from "../src/db/schema";
import { seedConfig } from "../src/services/config";

const goalCount = db.select({ n: count() }).from(organizedGoal).get()?.n ?? 0;
const habitCount = db.select({ n: count() }).from(habit).get()?.n ?? 0;
if (goalCount > 0 || habitCount > 0) {
  console.error(`refusing to seed a non-empty database (${goalCount} goals, ${habitCount} habits) — nuke first`);
  process.exit(1);
}

const vid = () => crypto.randomUUID();
const versioned = (id: string) => ({ id, lineageId: id, version: 1 });

const GOALS = [
  {
    title: "Higher agency",
    identityClause: "I am becoming someone who acts on his own judgment the same day he forms it.",
    synthesisMd:
      "The pattern under everything: I wait for permission that never comes. Days where this goal is true start with me picking the one uncomfortable thing and doing it before noon.",
    priorityRank: 1,
  },
  {
    title: "Physical base",
    identityClause: "I am becoming someone whose body can carry his ambitions.",
    synthesisMd:
      "Sleep, lifting, and walks are not self-care garnish; they are the substrate. When this is true I train three times a week without negotiating with myself.",
    priorityRank: 2,
  },
] as const;

const HABITS = [
  { title: "Morning pages", status: "established", preferredTime: "07:30", durationMinutes: 20 },
  { title: "Lift (3x/week)", status: "building", preferredTime: "18:00", durationMinutes: 60 },
  { title: "Doomscrolling after midnight", status: "established", valence: "bad" as const },
] as const;

const IDEAS = [
  { title: "Phone charges outside the bedroom", goal: 1, why: "Kills the midnight scroll at the socket, protects sleep for training days." },
  { title: "Ship one small public thing per week", goal: 0, why: "Agency is a muscle; a weekly public rep removes the permission-waiting." },
  { title: "Walk-and-call for every catch-up", goal: 1, why: "Turns social debt into base mileage instead of couch time." },
] as const;

const goalIds: string[] = [];
for (const g of GOALS) {
  const id = vid();
  db.insert(organizedGoal).values({ ...versioned(id), ...g, status: "active" }).run();
  goalIds.push(id);
}
for (const h of HABITS) {
  db.insert(habit).values({ ...versioned(vid()), origin: "manual", ...h }).run();
}
for (const idea of IDEAS) {
  const id = vid();
  db.insert(experimentIdea).values({ ...versioned(id), title: idea.title }).run();
  db.insert(ideaGoal)
    .values({ ideaLineageId: id, goalLineageId: goalIds[idea.goal]!, description: idea.why })
    .run();
}
const deadline = new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10);
db.insert(task).values({ ...versioned(vid()), title: "Renew passport", deadlineDate: deadline }).run();

const configSeeded = seedConfig(false);
console.log(
  JSON.stringify(
    { goals: GOALS.length, habits: HABITS.length, ideas: IDEAS.length, tasks: 1, config: configSeeded },
    null,
    2,
  ),
);
