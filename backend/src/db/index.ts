import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { env } from "../lib/env";
import * as schema from "./schema";

mkdirSync(dirname(env.DB_PATH), { recursive: true });

const sqlite = new Database(env.DB_PATH, { create: true });
sqlite.exec("PRAGMA journal_mode = WAL;");
sqlite.exec("PRAGMA foreign_keys = ON;");

export const db = drizzle(sqlite, { schema });

export function runMigrations() {
  migrate(db, { migrationsFolder: join(import.meta.dir, "../../drizzle") });
}

// Migrate at module load: every entrypoint (server, CLI, tests) gets the schema for free.
runMigrations();

// Admin-only hard delete (§ N7): empties every table, schema stays.
export function wipeAllTables() {
  sqlite.exec("PRAGMA foreign_keys = OFF;");
  const tables = [
    // children first
    "daily_plan_item",
    "daily_plan",
    "conversation_record_link",
    "lineage_parent",
    "group_idea",
    "group_habit",
    "idea_goal",
    "idea_project",
    "goal_pattern",
    "task",
    "experiment_idea",
    "pattern_of_behavior",
    "leisure_activity",
    "companion_branch_draft",
    "draft_change_set",
    "collaboration_workspace_index",
    "collaboration_workspace",
    "collaboration_invite",
    "current_focus_goal",
    "current_focus",
    "experiment_group_project",
    "experiment_group_context",
    "experiment_group_target",
    "experiment_group_source",
    "experiment_group_goal",
    "experiment_organized_goal",
    "organized_goal_source",
    "organized_registry_source",
    "project_source",
    "chat_message",
    "chat_session",
    "calendar_event",
    "anchor_event",
    "extraction_link",
    "experiment_task_goal",
    "experiment_task",
    "experiment_goal",
    "witness_goal",
    "witness",
    "goal_habit",
    "goal_environment",
    "experience",
    "environment_item",
    "habit",
    "daily_writeup",
    "strike_state",
    "inbound_message",
    "outbound_message",
    "review_writeup",
    "proposal",
    "extraction",
    "agent_run",
    "event",
    "goal_evidence",
    "experiment",
    "experiment_group",
    "organized_environment_item",
    "organized_habit",
    "organized_goal",
    "project",
    "goal",
    "conversation",
    "google_auth",
    "config",
  ];
  for (const t of tables) sqlite.exec(`DELETE FROM ${t};`);
  sqlite.exec("PRAGMA foreign_keys = ON;");
}
