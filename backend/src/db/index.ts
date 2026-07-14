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
    "chat_message",
    "chat_session",
    "calendar_event",
    "anchor_event",
    "extraction_link",
    "experiment_task",
    "experiment_goal",
    "goal_habit",
    "goal_environment",
    "experience",
    "environment_item",
    "habit",
    "daily_writeup",
    "strike_state",
    "proposal",
    "extraction",
    "agent_run",
    "event",
    "goal_evidence",
    "experiment",
    "goal",
    "conversation",
    "google_auth",
    "config",
  ];
  for (const t of tables) sqlite.exec(`DELETE FROM ${t};`);
  sqlite.exec("PRAGMA foreign_keys = ON;");
}
