import { app } from "./app";
import { env } from "../lib/env";
import { mcpHttpServer } from "../mcp/http";
import { initMessaging } from "../services/messaging/messenger";

// Give the strike tripwire its delivery sink (mock transport until a real one
// is configured) — registration only; nothing sends without an approved row.
initMessaging();

Bun.serve({
  port: env.PORT,
  hostname: env.BIND_HOST,
  fetch(request, server) {
    // Bun can provide the actual socket peer IP, unlike the generic Fetch
    // request surface used by Hono. Feed it only to the MCP rate limiter;
    // normal API behavior remains exactly the existing Hono application.
    if (new URL(request.url).pathname === "/mcp") {
      return mcpHttpServer.handle(request, server.requestIP(request)?.address);
    }
    return app.fetch(request);
  },
});
console.log(`dream backend listening on http://${env.BIND_HOST}:${env.PORT}`);
