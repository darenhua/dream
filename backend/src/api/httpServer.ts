import { app } from "./app";
import { env } from "../lib/env";
import { mcpHttpServer } from "../mcp/http";

type ApplicationHandler = {
  fetch(request: Request): Response | Promise<Response>;
};

type McpHandler = {
  handle(request: Request): Response | Promise<Response>;
};

export type BackendServerOptions = {
  /** Bind to an ephemeral port in localhost integration tests. */
  port?: number;
  hostname?: string;
  application?: ApplicationHandler;
  mcpHttpHandler?: McpHandler;
};

/** Routes /mcp to the Dream MCP host; everything else to the Hono app. */
export function createBackendRequestHandler({
  application = app,
  mcpHttpHandler = mcpHttpServer,
}: Pick<BackendServerOptions, "application" | "mcpHttpHandler"> = {}) {
  return (request: Request): Response | Promise<Response> => {
    const pathname = new URL(request.url).pathname;
    if (pathname === "/mcp") {
      return mcpHttpHandler.handle(request);
    }
    return application.fetch(request);
  };
}

export function startBackendServer({
  port = env.PORT,
  hostname = env.BIND_HOST,
  application,
  mcpHttpHandler,
}: BackendServerOptions = {}) {
  const handleRequest = createBackendRequestHandler({ application, mcpHttpHandler });

  return Bun.serve({
    port,
    hostname,
    fetch(request) {
      return handleRequest(request);
    },
  });
}
