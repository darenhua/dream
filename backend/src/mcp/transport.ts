import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { env } from "../lib/env";

// Shared, stateless Streamable HTTP transport helpers. Both MCP endpoints —
// the code-linked creator host and the authenticated companion host — apply
// the same origin/host rebinding policy and response hygiene while keeping
// entirely separate session maps and authority models.

export type RequestPolicy = {
  allowed: boolean;
  /** A normalized, explicitly allowed browser origin, if this is a CORS request. */
  corsOrigin: string | null;
};

export const MCP_METHODS = new Set(["GET", "POST", "DELETE", "OPTIONS"]);
const CORS_METHODS = "GET, POST, DELETE, OPTIONS";
const CORS_HEADERS = "content-type, accept, authorization, mcp-session-id, mcp-protocol-version, last-event-id";

export function jsonRpcError(status: number, code: number, message: string): Response {
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

export function requestHost(request: Request): string | null {
  const forwarded = env.MCP_TRUST_PROXY ? request.headers.get("x-forwarded-host") : null;
  return host(forwarded ?? request.headers.get("host") ?? new URL(request.url).host);
}

export function requestPolicy(request: Request): RequestPolicy {
  const allowedOrigins = new Set([...configuredOrigins()]);
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

export function clientKey(request: Request, peerAddress?: string): string {
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

export async function isNewSessionRequest(request: Request): Promise<boolean> {
  if (request.method !== "POST") return false;
  try {
    return hasInitializeRequest(await request.clone().json());
  } catch {
    return false;
  }
}

export function secureResponse(response: Response, corsOrigin: string | null): Response {
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
