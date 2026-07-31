import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { env } from "../src/lib/env";
import { getConfig, setConfig } from "../src/services/config";
import { isConnected } from "../src/services/google/auth";
import { createAdminMcpRoutes } from "../src/mcp/adminHttp";

// env is module-load state; tests flip fields in place and restore. The MCP
// host/origin allowlists are cleared so a deployed .env (staging hosts) can't
// 403 the loopback test requests before auth is even evaluated.
const savedAppEnv = env.APP_ENV;
const savedToken = env.ADMIN_MCP_TOKEN_SHA256;
const savedHosts = env.MCP_ALLOWED_HOSTS;
const savedOrigins = env.MCP_ALLOWED_ORIGINS;
beforeEach(() => {
  (env as { MCP_ALLOWED_HOSTS: string[] }).MCP_ALLOWED_HOSTS = [];
  (env as { MCP_ALLOWED_ORIGINS: string[] }).MCP_ALLOWED_ORIGINS = [];
});
afterEach(() => {
  (env as { APP_ENV: string }).APP_ENV = savedAppEnv;
  (env as { ADMIN_MCP_TOKEN_SHA256: string }).ADMIN_MCP_TOKEN_SHA256 = savedToken;
  (env as { MCP_ALLOWED_HOSTS: string[] }).MCP_ALLOWED_HOSTS = savedHosts;
  (env as { MCP_ALLOWED_ORIGINS: string[] }).MCP_ALLOWED_ORIGINS = savedOrigins;
});

describe("non-prod side-effect kill-switch", () => {
  test("staging pins TRANSPORT and STRIKE_ALERTS_ENABLED regardless of stored config", () => {
    setConfig("TRANSPORT", "external");
    setConfig("STRIKE_ALERTS_ENABLED", true);
    try {
      (env as { APP_ENV: string }).APP_ENV = "staging";
      expect(getConfig<string>("TRANSPORT")).toBe("mock");
      expect(getConfig<boolean>("STRIKE_ALERTS_ENABLED")).toBe(false);
      expect(isConnected()).toBe(false);

      (env as { APP_ENV: string }).APP_ENV = "dev";
      expect(getConfig<string>("TRANSPORT")).toBe("external");
      expect(getConfig<boolean>("STRIKE_ALERTS_ENABLED")).toBe(true);
    } finally {
      setConfig("TRANSPORT", "mock");
      setConfig("STRIKE_ALERTS_ENABLED", false);
    }
  });
});

describe("admin MCP endpoint", () => {
  const TOKEN = "test-admin-token";
  const initializeBody = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "test", version: "0" },
    },
  });
  const post = (headers: Record<string, string>) =>
    createAdminMcpRoutes().request("/admin-mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...headers,
      },
      body: initializeBody,
    });

  test("404s when no token is configured (fail closed)", async () => {
    (env as { ADMIN_MCP_TOKEN_SHA256: string }).ADMIN_MCP_TOKEN_SHA256 = "";
    expect((await post({})).status).toBe(404);
  });

  test("401s on missing or wrong bearer", async () => {
    (env as { ADMIN_MCP_TOKEN_SHA256: string }).ADMIN_MCP_TOKEN_SHA256 = createHash("sha256")
      .update(TOKEN)
      .digest("hex");
    expect((await post({})).status).toBe(401);
    expect((await post({ authorization: "Bearer nope" })).status).toBe(401);
  });

  test("correct bearer initializes a dream-admin MCP session", async () => {
    (env as { ADMIN_MCP_TOKEN_SHA256: string }).ADMIN_MCP_TOKEN_SHA256 = createHash("sha256")
      .update(TOKEN)
      .digest("hex");
    const res = await post({ authorization: `Bearer ${TOKEN}` });
    expect(res.status).toBe(200);
    expect(res.headers.get("mcp-session-id")).toBeTruthy();
    expect(await res.text()).toContain("dream-admin");
  });
});
