import { Hono } from "hono";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { env } from "../lib/env";
import { createCollaborationMcpServer, type McpSessionBinding } from "./server";

class SessionBinding implements McpSessionBinding {
  #sessionId: string | null = null;
  #workspaceId: string | null = null;

  constructor(readonly clientKey: string) {}

  get sessionId(): string | null {
    return this.#sessionId;
  }

  get workspaceId(): string | null {
    return this.#workspaceId;
  }

  setSessionId(sessionId: string) {
    this.#sessionId = sessionId;
  }

  bindWorkspace(workspaceId: string) {
    this.#workspaceId = workspaceId;
  }

  clearWorkspace() {
    this.#workspaceId = null;
  }
}

type Connection = {
  binding: SessionBinding;
  transport: WebStandardStreamableHTTPServerTransport;
  lastTouchedAt: number;
  idleTimer: ReturnType<typeof setTimeout> | null;
};

type RequestPolicy = {
  allowed: boolean;
  /** A normalized, explicitly allowed browser origin, if this is a CORS request. */
  corsOrigin: string | null;
};

const MCP_METHODS = new Set(["GET", "POST", "DELETE", "OPTIONS"]);
const CORS_METHODS = "GET, POST, DELETE, OPTIONS";
const CORS_HEADERS = "content-type, accept, mcp-session-id, mcp-protocol-version, last-event-id";

function jsonRpcError(status: number, code: number, message: string): Response {
  return new Response(
    JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }),
    { status, headers: { "content-type": "application/json" } },
  );
}

function origin(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.origin : null;
  } catch {
    return null;
  }
}

function host(value: string | null): string | null {
  if (!value) return null;
  const raw = value.split(",")[0]?.trim();
  // Host headers cannot contain these characters. Reject rather than relying
  // on URL's permissive user-info/path parsing for the rebinding boundary.
  if (!raw || /[\s/@?#]/.test(raw)) return null;
  try {
    const url = new URL(`http://${raw}`);
    if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) return null;
    // Treat standard explicit ports like their implicit counterparts. This
    // keeps an allowlist of mcp.example.com usable with Host: mcp.example.com:443.
    const port = url.port === "80" || url.port === "443" ? "" : url.port;
    return `${url.hostname.toLowerCase()}${port ? `:${port}` : ""}`;
  } catch {
    return null;
  }
}

function configuredOrigins(): Set<string> {
  return new Set(
    [...env.MCP_ALLOWED_ORIGINS, env.MCP_PUBLIC_URL]
      .map(value => origin(value))
      .filter((value): value is string => !!value),
  );
}

function configuredHosts(): Set<string> {
  return new Set(
    [...env.MCP_ALLOWED_HOSTS, env.MCP_PUBLIC_URL]
      .map(value => {
        try {
          return host(new URL(value).host);
        } catch {
          return host(value);
        }
      })
      .filter((value): value is string => !!value),
  );
}

function requestHost(request: Request): string | null {
  const forwarded = env.MCP_TRUST_PROXY ? request.headers.get("x-forwarded-host") : null;
  return host(forwarded ?? request.headers.get("host") ?? new URL(request.url).host);
}

function requestPolicy(request: Request): RequestPolicy {
  const allowedOrigins = new Set([
    ...configuredOrigins(),
  ]);
  const requestedOriginHeader = request.headers.get("origin");
  const requestedOrigin = origin(requestedOriginHeader);
  // If a browser sends Origin, it must be syntactically valid. With a remote
  // public endpoint configured, it must also be explicitly allowlisted. A
  // server-to-server MCP client legitimately sends no Origin header.
  if (requestedOriginHeader && (!requestedOrigin || (allowedOrigins.size > 0 && !allowedOrigins.has(requestedOrigin)))) {
    return { allowed: false, corsOrigin: null };
  }

  const allowedHosts = configuredHosts();
  const requestedHost = requestHost(request);
  if (!requestedHost || (allowedHosts.size > 0 && !allowedHosts.has(requestedHost))) {
    return { allowed: false, corsOrigin: null };
  }
  return { allowed: true, corsOrigin: requestedOrigin };
}

function clientKey(request: Request, peerAddress?: string): string {
  // Forwarded headers are attacker-controlled unless a private, trusted
  // proxy overwrites them. Direct Bun deployments receive the actual peer IP
  // from server.requestIP instead; the host fallback only affects in-process
  // tests and non-Bun adapters.
  if (env.MCP_TRUST_PROXY) {
    const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
    const realIp = request.headers.get("x-real-ip")?.trim();
    if (forwarded) return `forwarded:${forwarded}`;
    if (realIp) return `real-ip:${realIp}`;
  }
  if (peerAddress) return `peer:${peerAddress}`;
  return `host:${requestHost(request) ?? "unknown"}`;
}

function hasInitializeRequest(body: unknown): boolean {
  return isInitializeRequest(body) || (Array.isArray(body) && body.some(isInitializeRequest));
}

async function isNewSessionRequest(request: Request): Promise<boolean> {
  if (request.method !== "POST") return false;
  try {
    return hasInitializeRequest(await request.clone().json());
  } catch {
    return false;
  }
}

/**
 * A stateful Streamable HTTP host. The SDK's MCP session id is an ephemeral
 * transport capability, while the one-time dashboard code later binds it to
 * exactly one collaboration workspace. A process restart intentionally clears
 * this map; the user can open a fresh dashboard code rather than inheriting a
 * broad durable MCP credential.
 */
export class CollaborationMcpHttpServer {
  #connections = new Map<string, Connection>();
  #pendingInitializations = 0;

  async #newConnection(client: string): Promise<Connection> {
    const binding = new SessionBinding(client);
    let connection: Connection;
    const forget = (sessionId: string) => {
      const current = this.#connections.get(sessionId);
      if (current === connection) {
        current.binding.clearWorkspace();
        if (current.idleTimer) clearTimeout(current.idleTimer);
        this.#connections.delete(sessionId);
      }
    };

    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      onsessioninitialized: sessionId => {
        binding.setSessionId(sessionId);
        this.#connections.set(sessionId, connection);
        this.#touchConnection(sessionId, connection);
      },
      onsessionclosed: forget,
    });
    connection = { binding, transport, lastTouchedAt: Date.now(), idleTimer: null };
    const server = createCollaborationMcpServer(binding);

    // Connect before handling initialize so the transport can return the
    // initialize response through this same stateful instance.
    await server.connect(transport);
    return connection;
  }

  async handle(request: Request, peerAddress?: string): Promise<Response> {
    const policy = requestPolicy(request);
    if (!policy.allowed) {
      return this.#secureResponse(jsonRpcError(403, -32003, "MCP request origin or host is not allowed."), policy.corsOrigin);
    }
    if (!MCP_METHODS.has(request.method)) {
      return this.#secureResponse(
        jsonRpcError(405, -32000, "MCP endpoint only supports GET, POST, DELETE, and OPTIONS."),
        policy.corsOrigin,
      );
    }
    if (request.method === "OPTIONS") {
      return this.#secureResponse(new Response(null, { status: 204 }), policy.corsOrigin);
    }
    this.#pruneIdleConnections();
    const sessionId = request.headers.get("mcp-session-id");
    if (sessionId) {
      const connection = this.#connections.get(sessionId);
      if (!connection) {
        return this.#secureResponse(
          jsonRpcError(404, -32001, "MCP session not found; start a new collaboration connection."),
          policy.corsOrigin,
        );
      }
      this.#touchConnection(sessionId, connection);
      return this.#secureResponse(await connection.transport.handleRequest(request), policy.corsOrigin);
    }

    if (!(await isNewSessionRequest(request))) {
      return this.#secureResponse(
        jsonRpcError(400, -32000, "MCP initialization is required before calling collaboration tools."),
        policy.corsOrigin,
      );
    }

    const maximum = env.MCP_MAX_SESSIONS;
    if (this.#connections.size + this.#pendingInitializations >= maximum) {
      return this.#secureResponse(
        jsonRpcError(429, -32029, "Too many active MCP sessions; wait for an existing session to close."),
        policy.corsOrigin,
      );
    }

    this.#pendingInitializations++;
    let connection: Connection | null = null;
    try {
      connection = await this.#newConnection(clientKey(request, peerAddress));
      return this.#secureResponse(await connection.transport.handleRequest(request), policy.corsOrigin);
    } catch (error) {
      // The transport has not necessarily emitted a session id yet. Remove a
      // half-initialized connection if it did so before reporting its error.
      if (connection?.binding.sessionId) this.#dropConnection(connection.binding.sessionId, connection);
      return this.#secureResponse(
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
    connection.binding.clearWorkspace();
    if (connection.idleTimer) clearTimeout(connection.idleTimer);
    this.#connections.delete(sessionId);
    // Deleting the map entry revokes routing; closing additionally terminates
    // a lingering SSE stream and frees SDK resources after idle expiry.
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
    // A server already keeps the process alive. The expiry helper should not
    // keep a CLI/test process alive after its only work is complete.
    (timer as unknown as { unref?: () => void }).unref?.();
    connection.idleTimer = timer;
  }

  #secureResponse(response: Response, corsOrigin: string | null): Response {
    const headers = new Headers(response.headers);
    headers.set("cache-control", "no-store");
    headers.set("x-content-type-options", "nosniff");
    if (corsOrigin) {
      headers.set("access-control-allow-origin", corsOrigin);
      headers.set("access-control-allow-methods", CORS_METHODS);
      headers.set("access-control-allow-headers", CORS_HEADERS);
      headers.set("access-control-max-age", "600");
      const vary = headers.get("vary");
      headers.set("vary", vary ? `${vary}, Origin` : "Origin");
    }
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  }
}

export function createMcpRoutes(host = new CollaborationMcpHttpServer()) {
  const routes = new Hono();
  routes.all("/mcp", c => host.handle(c.req.raw));
  return routes;
}

// This shared host lets Bun pass a trusted socket peer address in production;
// Hono's test/request adapter still uses the same handler without that hint.
export const mcpHttpServer = new CollaborationMcpHttpServer();
export const mcpRoutes = createMcpRoutes(mcpHttpServer);
