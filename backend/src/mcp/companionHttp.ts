import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { env } from "../lib/env";
import {
  bearerTokenFromRequest,
  resolveCompanionIdentity,
  type CompanionIdentity,
} from "../services/companion";
import type { SourceRef } from "../services/organized";
import { createCompanionMcpServer, type CompanionSessionBinding } from "./companionServer";
import { MCP_METHODS, isNewSessionRequest, jsonRpcError, requestPolicy, secureResponse } from "./transport";

function refKey(ref: SourceRef): string {
  return `${ref.entityType}:${ref.entityId}`;
}

class CompanionBinding implements CompanionSessionBinding {
  #sessionId: string | null = null;
  #discovered = new Set<string>();

  constructor(readonly identity: CompanionIdentity) {}

  get sessionId(): string | null {
    return this.#sessionId;
  }

  setSessionId(sessionId: string) {
    this.#sessionId = sessionId;
  }

  hasDiscovered(ref: SourceRef): boolean {
    return this.#discovered.has(refKey(ref));
  }

  discover(refs: SourceRef[]) {
    // Bound the allowlist so a pathological session cannot grow it without
    // limit; the cap is far above any real conversation's traversal.
    for (const ref of refs) {
      if (this.#discovered.size >= 5_000) return;
      this.#discovered.add(refKey(ref));
    }
  }
}

type Connection = {
  binding: CompanionBinding;
  transport: WebStandardStreamableHTTPServerTransport;
  lastTouchedAt: number;
  idleTimer: ReturnType<typeof setTimeout> | null;
};

/**
 * The persistent companion's dedicated Streamable HTTP host. It shares the
 * origin/host hygiene of the creator endpoint but nothing else: an
 * independent session map, no redeem_collaboration_code tool, and fail-closed
 * authentication evaluated on EVERY request — initialization and
 * continuations — so an mcp-session-id never becomes a bearer credential.
 */
export class CompanionMcpHttpServer {
  #connections = new Map<string, Connection>();
  #pendingInitializations = 0;

  async #newConnection(identity: CompanionIdentity): Promise<Connection> {
    const binding = new CompanionBinding(identity);
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
        binding.setSessionId(sessionId);
        this.#connections.set(sessionId, connection);
        this.#touchConnection(sessionId, connection);
      },
      onsessionclosed: forget,
    });
    connection = { binding, transport, lastTouchedAt: Date.now(), idleTimer: null };
    const server = createCompanionMcpServer(binding);
    await server.connect(transport);
    return connection;
  }

  async handle(request: Request, peerAddress?: string): Promise<Response> {
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

    // Authenticate before touching the session map at all. Unconfigured or
    // wrong-credential requests fail before any session state can exist.
    const identity = resolveCompanionIdentity({ bearerToken: bearerTokenFromRequest(request), peerAddress });
    if (!identity) {
      return secureResponse(
        jsonRpcError(401, -32004, "Companion access is not configured or the credential is invalid."),
        policy.corsOrigin,
      );
    }

    this.#pruneIdleConnections();
    const sessionId = request.headers.get("mcp-session-id");
    if (sessionId) {
      const connection = this.#connections.get(sessionId);
      if (!connection) {
        return secureResponse(
          jsonRpcError(404, -32001, "Companion MCP session not found; initialize a new connection."),
          policy.corsOrigin,
        );
      }
      if (connection.binding.identity.subject !== identity.subject) {
        return secureResponse(
          jsonRpcError(403, -32005, "This companion session belongs to a different identity."),
          policy.corsOrigin,
        );
      }
      this.#touchConnection(sessionId, connection);
      return secureResponse(await connection.transport.handleRequest(request), policy.corsOrigin);
    }

    if (!(await isNewSessionRequest(request))) {
      return secureResponse(
        jsonRpcError(400, -32000, "MCP initialization is required before calling companion tools."),
        policy.corsOrigin,
      );
    }

    if (this.#connections.size + this.#pendingInitializations >= env.MCP_MAX_SESSIONS) {
      return secureResponse(
        jsonRpcError(429, -32029, "Too many active MCP sessions; wait for an existing session to close."),
        policy.corsOrigin,
      );
    }

    this.#pendingInitializations++;
    let connection: Connection | null = null;
    try {
      connection = await this.#newConnection(identity);
      return secureResponse(await connection.transport.handleRequest(request), policy.corsOrigin);
    } catch (error) {
      if (connection?.binding.sessionId) this.#dropConnection(connection.binding.sessionId, connection);
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

// Production Bun serving passes the socket peer address through the backend
// request handler; the loopback-owner adapter never trusts anything else.
export const companionMcpHttpServer = new CompanionMcpHttpServer();
