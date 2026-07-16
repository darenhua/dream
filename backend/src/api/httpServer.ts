import { app } from "./app";
import { env } from "../lib/env";
import { mcpHttpServer } from "../mcp/http";
import { companionMcpHttpServer } from "../mcp/companionHttp";
import { PEER_ADDRESS_HEADER } from "./routes/companion";

type ApplicationHandler = {
  fetch(request: Request): Response | Promise<Response>;
};

type McpHandler = {
  handle(request: Request, peerAddress?: string): Response | Promise<Response>;
};

export type BackendServerOptions = {
  /** Bind to an ephemeral port in localhost integration tests. */
  port?: number;
  hostname?: string;
  application?: ApplicationHandler;
  mcpHttpHandler?: McpHandler;
  companionMcpHttpHandler?: McpHandler;
};

/**
 * Routes a request after Bun has supplied its socket-derived peer address.
 * Keeping this separate from Bun.serve makes the routing boundary testable
 * while retaining the trusted-peer input that Hono's generic Fetch adapter
 * cannot expose.
 */
export function createBackendRequestHandler({
  application = app,
  mcpHttpHandler = mcpHttpServer,
  companionMcpHttpHandler = companionMcpHttpServer,
}: Pick<BackendServerOptions, "application" | "mcpHttpHandler" | "companionMcpHttpHandler"> = {}) {
  return (request: Request, peerAddress?: string): Response | Promise<Response> => {
    // Bun can provide the actual socket peer IP, unlike the generic Fetch
    // request surface used by Hono. Feed it to the MCP hosts (creator rate
    // limiting, companion authentication); normal API behavior remains the
    // existing Hono application.
    const pathname = new URL(request.url).pathname;
    if (pathname === "/mcp") {
      return mcpHttpHandler.handle(request, peerAddress);
    }
    if (pathname === "/companion-mcp") {
      return companionMcpHttpHandler.handle(request, peerAddress);
    }
    // The companion inbox authorizes its loopback-owner adapter from the
    // socket peer, carried on a trusted header. Sanitize it on EVERY
    // app-bound request — never on a path prefix, because the router
    // percent-decodes paths while URL.pathname does not, so a prefix check
    // could be dodged with an encoded path (e.g. /api/%63ompanion/...).
    // Only routes/companion.ts reads the header, so a global strip is safe.
    // The request is rebuilt from its URL because `new Request(request,
    // init)` merges init.headers over the original, which would keep a
    // deleted spoofed header alive.
    if (request.headers.has(PEER_ADDRESS_HEADER) || peerAddress) {
      const headers = new Headers(request.headers);
      headers.delete(PEER_ADDRESS_HEADER);
      if (peerAddress) headers.set(PEER_ADDRESS_HEADER, peerAddress);
      const sanitized = new Request(request.url, {
        method: request.method,
        headers,
        body: request.body,
      });
      return application.fetch(sanitized);
    }
    return application.fetch(request);
  };
}

/**
 * Start the production HTTP shape with injectable handlers for localhost MCP
 * trajectory tests. The entrypoint remains responsible for process startup
 * concerns such as messaging initialization and logging.
 */
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
    fetch(request, server) {
      return handleRequest(request, server.requestIP(request)?.address);
    },
  });
}
