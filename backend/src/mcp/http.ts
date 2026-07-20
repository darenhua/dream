import { Hono } from "hono";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { env } from "../lib/env";
import { createDreamMcpServer } from "./dreamServer";
import { MCP_METHODS, isNewSessionRequest, jsonRpcError, requestPolicy, secureResponse } from "./transport";

type Connection = {
  transport: WebStandardStreamableHTTPServerTransport;
  lastTouchedAt: number;
  idleTimer: ReturnType<typeof setTimeout> | null;
};

/**
 * The single persistent Dream MCP host. Stateful Streamable HTTP with
 * per-connection MCP sessions, idle pruning, and the origin/host rebinding
 * policy — but no auth ceremony: no codes, no identities, no capability
 * binding. The server is the user's own machine.
 */
export class DreamMcpHttpServer {
  #connections = new Map<string, Connection>();
  #pendingInitializations = 0;

  async #newConnection(): Promise<Connection> {
    let connection: Connection;
    const forget = (sessionId: string) => {
      const current = this.#connections.get(sessionId);
      if (current === connection) {
        if (current.idleTimer) clearTimeout(current.idleTimer);
        this.#connections.delete(sessionId);
      }
    };

    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      onsessioninitialized: sessionId => {
        this.#connections.set(sessionId, connection);
        this.#touchConnection(sessionId, connection);
      },
      onsessionclosed: forget,
    });
    connection = { transport, lastTouchedAt: Date.now(), idleTimer: null };
    const server = createDreamMcpServer();
    await server.connect(transport);
    return connection;
  }

  async handle(request: Request): Promise<Response> {
    const policy = requestPolicy(request);
    if (!policy.allowed) {
      return secureResponse(jsonRpcError(403, -32003, "MCP request origin or host is not allowed."), policy.corsOrigin);
    }
    if (!MCP_METHODS.has(request.method)) {
      return secureResponse(
        jsonRpcError(405, -32000, "MCP endpoint only supports GET, POST, DELETE, and OPTIONS."),
        policy.corsOrigin,
      );
    }
    if (request.method === "OPTIONS") {
      return secureResponse(new Response(null, { status: 204 }), policy.corsOrigin);
    }
    this.#pruneIdleConnections();
    const sessionId = request.headers.get("mcp-session-id");
    if (sessionId) {
      const connection = this.#connections.get(sessionId);
      if (!connection) {
        return secureResponse(jsonRpcError(404, -32001, "MCP session not found; reconnect."), policy.corsOrigin);
      }
      this.#touchConnection(sessionId, connection);
      return secureResponse(await connection.transport.handleRequest(request), policy.corsOrigin);
    }

    if (!(await isNewSessionRequest(request))) {
      return secureResponse(jsonRpcError(400, -32000, "MCP initialization is required first."), policy.corsOrigin);
    }

    if (this.#connections.size + this.#pendingInitializations >= env.MCP_MAX_SESSIONS) {
      return secureResponse(
        jsonRpcError(429, -32029, "Too many active MCP sessions; wait for an existing session to close."),
        policy.corsOrigin,
      );
    }

    this.#pendingInitializations++;
    try {
      const connection = await this.#newConnection();
      return secureResponse(await connection.transport.handleRequest(request), policy.corsOrigin);
    } catch (error) {
      return secureResponse(
        jsonRpcError(500, -32603, error instanceof Error ? error.message : "MCP internal server error"),
        policy.corsOrigin,
      );
    } finally {
      this.#pendingInitializations--;
    }
  }

  get sessionCount(): number {
    this.#pruneIdleConnections();
    return this.#connections.size;
  }

  #pruneIdleConnections() {
    const maxIdleMs = env.MCP_SESSION_IDLE_MINUTES * 60_000;
    const now = Date.now();
    for (const [sessionId, connection] of this.#connections) {
      if (now - connection.lastTouchedAt < maxIdleMs) continue;
      this.#dropConnection(sessionId, connection);
    }
  }

  #dropConnection(sessionId: string, connection: Connection) {
    if (this.#connections.get(sessionId) !== connection) return;
    if (connection.idleTimer) clearTimeout(connection.idleTimer);
    this.#connections.delete(sessionId);
    void connection.transport.close().catch(() => {});
  }

  #touchConnection(sessionId: string, connection: Connection) {
    connection.lastTouchedAt = Date.now();
    if (connection.idleTimer) clearTimeout(connection.idleTimer);
    const idleMs = env.MCP_SESSION_IDLE_MINUTES * 60_000;
    const timer = setTimeout(() => {
      if (this.#connections.get(sessionId) !== connection) return;
      if (Date.now() - connection.lastTouchedAt >= idleMs) {
        this.#dropConnection(sessionId, connection);
      } else {
        this.#touchConnection(sessionId, connection);
      }
    }, idleMs);
    (timer as unknown as { unref?: () => void }).unref?.();
    connection.idleTimer = timer;
  }
}

export function createMcpRoutes(host = new DreamMcpHttpServer()) {
  const routes = new Hono();
  routes.all("/mcp", c => host.handle(c.req.raw));
  return routes;
}

export const mcpHttpServer = new DreamMcpHttpServer();
export const mcpRoutes = createMcpRoutes(mcpHttpServer);
