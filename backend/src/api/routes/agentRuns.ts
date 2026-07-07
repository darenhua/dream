import { desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { db } from "../../db";
import { agentRun } from "../../db/schema";

export const agentRunRoutes = new Hono();

agentRunRoutes.get("/", c => {
  const { limit } = c.req.query();
  return c.json(
    db
      .select()
      .from(agentRun)
      .orderBy(desc(agentRun.createdAt))
      .limit(limit ? Number(limit) : 50)
      .all(),
  );
});

// §9 — detail incl. the workspace snapshot content (A4 audit trail).
agentRunRoutes.get("/:id", c => {
  const row = db.select().from(agentRun).where(eq(agentRun.id, c.req.param("id"))).get();
  if (!row) return c.json({ error: "agent run not found" }, 404);

  let workspace: { name: string; content: string }[] = [];
  if (row.workspacePath && existsSync(row.workspacePath)) {
    const walk = (dir: string, prefix = ""): typeof workspace => {
      const out: typeof workspace = [];
      for (const entry of readdirSync(dir).sort()) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) out.push(...walk(full, `${prefix}${entry}/`));
        else out.push({ name: `${prefix}${entry}`, content: readFileSync(full, "utf-8") });
      }
      return out;
    };
    workspace = walk(row.workspacePath);
  }
  return c.json({ ...row, workspace });
});
