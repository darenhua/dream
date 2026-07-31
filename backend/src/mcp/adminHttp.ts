import { createHash, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { env } from "../lib/env";
import { createAdminMcpServer } from "./adminServer";
import { DreamMcpHttpServer } from "./http";

// /admin-mcp — the read-only inspection surface, fail-closed like the
// companion: without ADMIN_MCP_TOKEN_SHA256 the endpoint does not exist
// (404), and every request must carry the bearer token whose sha256 matches.
// The plaintext token lives only in the MCP client config and the VM secrets
// store; each environment gets its own token.

function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() ?? null;
}

export function isAuthorizedAdminRequest(request: Request): boolean {
  if (!env.ADMIN_MCP_TOKEN_SHA256) return false;
  const token = bearerToken(request);
  if (!token) return false;
  const presented = createHash("sha256").update(token).digest();
  let expected: Buffer;
  try {
    expected = Buffer.from(env.ADMIN_MCP_TOKEN_SHA256, "hex");
  } catch {
    return false;
  }
  if (expected.length !== presented.length) return false;
  return timingSafeEqual(presented, expected);
}

export function createAdminMcpRoutes(host = new DreamMcpHttpServer(createAdminMcpServer)) {
  const routes = new Hono();
  routes.all("/admin-mcp", c => {
    if (!env.ADMIN_MCP_TOKEN_SHA256) return c.json({ error: "admin MCP is not enabled" }, 404);
    if (!isAuthorizedAdminRequest(c.req.raw)) return c.json({ error: "unauthorized" }, 401);
    return host.handle(c.req.raw);
  });
  return routes;
}

export const adminMcpRoutes = createAdminMcpRoutes();
