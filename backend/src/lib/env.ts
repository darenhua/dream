// Bun auto-loads backend/.env; these are the only knobs outside the config table.

function flag(name: string, fallback = false): boolean {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  return v === "1" || v.toLowerCase() === "true";
}

function csv(name: string): string[] {
  return (process.env[name] ?? "")
    .split(",")
    .map(value => value.trim())
    .filter(Boolean);
}

function positiveInteger(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function mcpPublicOrigin(): string {
  const value = (process.env.MCP_PUBLIC_URL ?? "").trim();
  if (!value) return "";

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("MCP_PUBLIC_URL must be an absolute http(s) origin, such as https://mcp.example.com");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("MCP_PUBLIC_URL must use http or https");
  }
  // A cloud MCP connection carries the one-time dashboard code. Requiring TLS
  // outside a loopback development endpoint prevents that capability from
  // travelling over a public clear-text connection by configuration accident.
  if (url.protocol !== "https:" && !["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname)) {
    throw new Error("MCP_PUBLIC_URL must use https outside localhost");
  }
  return url.origin;
}

const APP_ENVS = ["prod", "staging", "preview", "dev"] as const;
type AppEnv = (typeof APP_ENVS)[number];

function appEnv(): AppEnv {
  const value = (process.env.APP_ENV ?? "dev").trim().toLowerCase();
  if (!(APP_ENVS as readonly string[]).includes(value)) {
    throw new Error(`APP_ENV must be one of ${APP_ENVS.join("|")}, got "${value}"`);
  }
  return value as AppEnv;
}

export const env = {
  // Which deployed environment this process is. Staging/preview run against
  // restored copies of prod data (including its Google refresh token), so they
  // must never fire real side effects — see SIDE_EFFECTS_BLOCKED below.
  APP_ENV: appEnv(),
  // Deployed commit, injected into backend/.env by the deploy poller; empty in dev.
  GIT_SHA: (process.env.GIT_SHA ?? "").trim(),

  PORT: Number(process.env.PORT ?? 3001),
  // Leave the default public for the existing direct API deployment. A
  // reverse-proxied production MCP endpoint should set this to 127.0.0.1.
  BIND_HOST: process.env.BIND_HOST ?? "0.0.0.0",
  DB_PATH: process.env.DB_PATH ?? "./data/dream.db",
  WORKSPACE_PATH: process.env.WORKSPACE_PATH ?? "./workspace",

  // --- inference provider ---
  // true → AWS Bedrock (standard AWS credential chain: env vars, ~/.aws, SSO);
  // false → first-party Anthropic API via ANTHROPIC_API_KEY.
  USE_BEDROCK: flag("USE_BEDROCK"),
  AWS_REGION: process.env.AWS_REGION ?? "us-west-2",
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? "",

  // --- google calendar (Desktop-app OAuth client) ---
  GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID ?? "",
  GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET ?? "",
  // The externally-reachable base URL for THIS server, used to build the
  // OAuth redirect. Local dev: unset → falls back to localhost:$PORT, which
  // Google allows unregistered for loopback addresses. Deployed (VM, etc.):
  // set to the public origin (e.g. http://100.48.129.170:8130) — Google
  // requires any non-loopback redirect_uri to be pre-registered in the
  // OAuth client's "Authorized redirect URIs" (Google Cloud Console).
  PUBLIC_URL: (process.env.PUBLIC_URL ?? "").replace(/\/$/, ""),

  // MCP deployment. Leave these blank for local development. A remotely
  // configured MCP endpoint should be HTTPS and set MCP_PUBLIC_URL; optional
  // host/origin allowlists reject unexpected browser/proxy traffic while
  // still allowing server-to-server MCP clients that send no Origin header.
  MCP_PUBLIC_URL: mcpPublicOrigin(),
  MCP_ALLOWED_ORIGINS: csv("MCP_ALLOWED_ORIGINS"),
  MCP_ALLOWED_HOSTS: csv("MCP_ALLOWED_HOSTS"),
  // Only enable this when the TLS proxy is the only network peer and it
  // overwrites X-Forwarded-* headers. See deployment.md for that boundary.
  MCP_TRUST_PROXY: flag("MCP_TRUST_PROXY"),
  MCP_SESSION_IDLE_MINUTES: positiveInteger("MCP_SESSION_IDLE_MINUTES", 30),
  MCP_MAX_SESSIONS: positiveInteger("MCP_MAX_SESSIONS", 100),
  MCP_REDEEM_MAX_ATTEMPTS: positiveInteger("MCP_REDEEM_MAX_ATTEMPTS", 8),
  MCP_REDEEM_WINDOW_MINUTES: positiveInteger("MCP_REDEEM_WINDOW_MINUTES", 15),
  MCP_REDEEM_MAX_TRACKED_CLIENTS: positiveInteger("MCP_REDEEM_MAX_TRACKED_CLIENTS", 10_000),

  // --- persistent no-code companion ---
  // The companion holds long-lived personal context, so it fails closed by
  // default. Exactly two adapters can open it:
  //  - COMPANION_AUTH_TOKEN_SHA256: hex sha256 of a high-entropy credential
  //    held only by the MCP client (single-user remote bridge). The plain
  //    token must never appear in dashboard code, URLs, or transcripts.
  //  - COMPANION_ALLOW_LOOPBACK_OWNER: private-local/test adapter that grants
  //    the fixed owner identity to loopback socket peers only.
  // A multi-user/public deployment needs a real per-user identity boundary
  // before either of these is acceptable; leave both unset to keep the
  // endpoint disabled.
  COMPANION_AUTH_TOKEN_SHA256: (process.env.COMPANION_AUTH_TOKEN_SHA256 ?? "").trim().toLowerCase(),
  COMPANION_ALLOW_LOOPBACK_OWNER: flag("COMPANION_ALLOW_LOOPBACK_OWNER"),

  // --- per-env admin MCP (read-only inspection) ---
  // Same fail-closed pattern as the companion: hex sha256 of a bearer token
  // held only by the MCP client. Unset → /admin-mcp is disabled entirely.
  ADMIN_MCP_TOKEN_SHA256: (process.env.ADMIN_MCP_TOKEN_SHA256 ?? "").trim().toLowerCase(),

  // --- outbound proxy ---
  // Bun's fetch honors HTTP(S)_PROXY from process.env at request time, so the
  // flag works by setting/clearing those vars below, before any client exists.
  USE_PROXY: flag("USE_PROXY"),
  PROXY_URL:
    process.env.PROXY_URL ||
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    "",
};

// The non-prod side-effect kill-switch. Staging/preview run prod-shaped data
// (snapshot restores carry the Google refresh token and real witness rows), so
// they force: mock messaging transport, strike alerts off (both via getConfig),
// and Google Calendar disconnected (via google/auth isConnected). Dev stays
// permissive — tests exercise the real paths and dev holds no prod data unless
// the developer deliberately restores some.
export function sideEffectsBlocked(): boolean {
  return env.APP_ENV === "staging" || env.APP_ENV === "preview";
}

// Apply the proxy flag to the process environment exactly once, at load.
// USE_PROXY=false must also *clear* inherited proxy vars (the user's shell
// exports a local proxy that otherwise captures all SDK traffic).
const PROXY_VARS = ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "ALL_PROXY", "all_proxy"];
if (env.USE_PROXY && env.PROXY_URL) {
  for (const name of PROXY_VARS) process.env[name] = env.PROXY_URL;
} else {
  for (const name of PROXY_VARS) delete process.env[name];
}
