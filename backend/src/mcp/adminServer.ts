import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { and, count, eq, getTableColumns, getTableName, is, isNull } from "drizzle-orm";
import { SQLiteTable } from "drizzle-orm/sqlite-core";
import { z } from "zod";
import { db } from "../db";
import * as schema from "../db/schema";
import { env, sideEffectsBlocked } from "../lib/env";
import { getConfig } from "../services/config";
import { isConnected } from "../services/google/auth";

// The per-environment admin inspection surface. READ-ONLY BY CONSTRUCTION:
// tools build drizzle SELECTs against known schema tables — there is no raw
// SQL input and no write path. Writes on non-prod environments go through the
// regular Dream MCP; ops (snapshot/restore/nuke) stay ssh scripts. Agents
// "swap environments" by swapping MCP endpoints (prod vs staging URL).

const ADMIN_SERVER_INSTRUCTIONS = `Read-only admin inspection of ONE Dream environment (check admin_env first —
it names the environment this connection answers for). Use admin_tables to
discover tables and row counts, admin_select for filtered rows (equality
filters only), admin_row for one full row by id. Nothing here can write.`;

const TABLES = new Map<string, SQLiteTable>();
for (const exported of Object.values(schema)) {
  if (is(exported, SQLiteTable)) TABLES.set(getTableName(exported), exported);
}

const MAX_ROWS = 200;

function resultText(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}
function errorText(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

function tableOr(name: string): SQLiteTable | null {
  return TABLES.get(name) ?? null;
}

const WhereSchema = z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]));

export function createAdminMcpServer(): McpServer {
  const server = new McpServer(
    { name: "dream-admin", version: "1.0.0" },
    { instructions: ADMIN_SERVER_INSTRUCTIONS },
  );

  server.registerTool(
    "admin_env",
    {
      title: "Identify this environment",
      description:
        "Which environment this connection inspects: APP_ENV, deployed sha, DB path, side-effect guard state, effective transport/strike/calendar flags. Call this first.",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () =>
      resultText({
        env: env.APP_ENV,
        sha: env.GIT_SHA || null,
        dbPath: env.DB_PATH,
        sideEffectsBlocked: sideEffectsBlocked(),
        effective: {
          transport: getConfig<string>("TRANSPORT"),
          strikeAlertsEnabled: getConfig<boolean>("STRIKE_ALERTS_ENABLED"),
          calendarConnected: isConnected(),
        },
        tables: TABLES.size,
      }),
  );

  server.registerTool(
    "admin_tables",
    {
      title: "List tables with row counts",
      description: "Every table in this environment's database with its current row count.",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      const out: Record<string, number> = {};
      for (const [name, table] of [...TABLES.entries()].sort(([a], [b]) => a.localeCompare(b))) {
        out[name] = db.select({ n: count() }).from(table).get()?.n ?? 0;
      }
      return resultText(out);
    },
  );

  server.registerTool(
    "admin_select",
    {
      title: "Select rows from a table",
      description:
        `Rows from one table, newest-insertion last. Optional equality-only filters ({column: value}; null matches IS NULL), limit (default 50, max ${MAX_ROWS}), offset for paging. Column names come from admin_select errors or a first unfiltered call.`,
      inputSchema: {
        table: z.string(),
        where: WhereSchema.optional(),
        limit: z.number().int().min(1).max(MAX_ROWS).optional(),
        offset: z.number().int().min(0).optional(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ table: tableName, where, limit, offset }) => {
      const table = tableOr(tableName);
      if (!table) return errorText(`unknown table "${tableName}" — admin_tables lists the valid names`);
      const columns = getTableColumns(table);
      const conditions = [];
      for (const [columnName, value] of Object.entries(where ?? {})) {
        const column = columns[columnName as keyof typeof columns];
        if (!column) {
          return errorText(
            `unknown column "${columnName}" on ${tableName}; columns: ${Object.keys(columns).join(", ")}`,
          );
        }
        conditions.push(value === null ? isNull(column) : eq(column, value));
      }
      const base = db.select().from(table);
      const filtered = conditions.length > 0 ? base.where(and(...conditions)) : base;
      const rows = filtered
        .limit(limit ?? 50)
        .offset(offset ?? 0)
        .all();
      return resultText({ table: tableName, rows: rows.length, data: rows });
    },
  );

  server.registerTool(
    "admin_row",
    {
      title: "Read one row by id",
      description: "One full row by primary id from a table that has an id column.",
      inputSchema: { table: z.string(), id: z.string() },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ table: tableName, id }) => {
      const table = tableOr(tableName);
      if (!table) return errorText(`unknown table "${tableName}" — admin_tables lists the valid names`);
      const columns = getTableColumns(table);
      const idColumn = columns["id" as keyof typeof columns];
      if (!idColumn) return errorText(`table ${tableName} has no id column; use admin_select with filters`);
      const row = db.select().from(table).where(eq(idColumn, id)).get();
      if (!row) return errorText(`no ${tableName} row with id ${id}`);
      return resultText(row);
    },
  );

  return server;
}
