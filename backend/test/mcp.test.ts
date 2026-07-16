import { afterEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { env } from "../src/lib/env";
import { CollaborationMcpHttpServer } from "../src/mcp/http";
import { configureCollaborationMcpBackend } from "../src/mcp/server";
import type { CollaborationMcpBackend, McpWorkspace } from "../src/mcp/contracts";

function text(result: unknown) {
  if (!result || typeof result !== "object" || !("content" in result) || !Array.isArray(result.content)) {
    throw new Error("expected a tool content result");
  }
  const first = result.content.find(
    (item): item is { type: string; text?: string } => typeof item === "object" && item !== null && "type" in item,
  );
  if (!first?.text) throw new Error("expected text result");
  return first.text;
}

async function connect(host: CollaborationMcpHttpServer) {
  const client = new Client({ name: "dream-mcp-test-client", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL("http://dream.test/mcp"), {
    fetch: (input, init) =>
      host.handle(input instanceof Request ? new Request(input, init) : new Request(String(input), init)),
  });
  await client.connect(transport);
  return { client, transport };
}

afterEach(() => configureCollaborationMcpBackend(null));

describe("collaboration MCP transport", () => {
  test("requires configured Host/Origin and returns constrained CORS responses", async () => {
    const original = {
      publicUrl: env.MCP_PUBLIC_URL,
      origins: env.MCP_ALLOWED_ORIGINS,
      hosts: env.MCP_ALLOWED_HOSTS,
      trustProxy: env.MCP_TRUST_PROXY,
    };
    Object.assign(env, {
      MCP_PUBLIC_URL: "https://mcp.dream.test",
      MCP_ALLOWED_ORIGINS: ["https://chatgpt.com"],
      MCP_ALLOWED_HOSTS: ["mcp.dream.test"],
      MCP_TRUST_PROXY: false,
    });

    try {
      const host = new CollaborationMcpHttpServer();
      const allowedPreflight = await host.handle(
        new Request("https://mcp.dream.test/mcp", {
          method: "OPTIONS",
          headers: { origin: "https://chatgpt.com" },
        }),
      );
      expect(allowedPreflight.status).toBe(204);
      expect(allowedPreflight.headers.get("access-control-allow-origin")).toBe("https://chatgpt.com");
      expect(allowedPreflight.headers.get("access-control-allow-methods")).toContain("POST");
      expect(allowedPreflight.headers.get("cache-control")).toBe("no-store");
      expect(allowedPreflight.headers.get("vary")).toContain("Origin");

      const rejectedOrigin = await host.handle(
        new Request("https://mcp.dream.test/mcp", {
          method: "OPTIONS",
          headers: { origin: "https://attacker.example" },
        }),
      );
      expect(rejectedOrigin.status).toBe(403);

      const rejectedHost = await host.handle(
        new Request("https://wrong-host.example/mcp", {
          method: "OPTIONS",
          headers: { origin: "https://chatgpt.com" },
        }),
      );
      expect(rejectedHost.status).toBe(403);
    } finally {
      Object.assign(env, {
        MCP_PUBLIC_URL: original.publicUrl,
        MCP_ALLOWED_ORIGINS: original.origins,
        MCP_ALLOWED_HOSTS: original.hosts,
        MCP_TRUST_PROXY: original.trustProxy,
      });
    }
  });

  test("redeems one code, restricts reads, and only writes a review draft", async () => {
    const workspace: McpWorkspace = {
      id: crypto.randomUUID(),
      mode: "organized_goal",
      status: "open",
      primaryEntityType: "organized_goal",
      primaryEntityId: null,
      experimentGroupId: null,
      prioritizeAction: null,
      userSeedMd: "higher agency",
      selectedOrganizedGoalIds: [],
      draft: null,
    };
    const calls = { read: 0, save: 0, submit: 0 };
    const backend: CollaborationMcpBackend = {
      async redeemCollaborationCode(code) {
        return code === "ABCD-1234" ? { ok: true, value: { workspace } } : { ok: false, error: "unknown code" };
      },
      async getWorkspace(id) {
        return id === workspace.id ? { ok: true, value: workspace } : { ok: false, error: "workspace not found" };
      },
    async readWorkspaceContext({ section }) {
      calls.read++;
      return { ok: true, value: { markdown: `# ${section}` } };
    },
    async getWorkspaceIndex(id) {
      return id === workspace.id
        ? {
            ok: true,
            value: {
              workspaceId: id,
              indexVersion: 1,
              generatedAt: new Date().toISOString(),
              markdown: "# Workspace index\n\nHigher agency",
              manifest: { referenceCount: 1 },
            },
          }
        : { ok: false, error: "workspace not found" };
    },
    async searchWorkspaceIndex({ query }) {
      return {
        ok: true,
        value: {
          markdown: `# Search\n\n${query}`,
          matches: [{ referenceType: "raw_goal", id: crypto.randomUUID(), title: "Act with agency" }],
          nextCursor: null,
        },
      };
    },
    async readEntityContext() {
      return { ok: true, value: { markdown: "# Indexed entity context" } };
    },
    async followProvenance() {
      return { ok: true, value: { markdown: "# Indexed provenance" } };
    },
      async saveDraftChangeSet({ summaryMd, operations, sourceRefs }) {
        calls.save++;
        return {
          ok: true,
          value: {
            id: crypto.randomUUID(),
            status: "drafting",
            summaryMd,
            operations,
            sourceRefs,
            updatedAt: new Date().toISOString(),
          },
        };
      },
      async submitDraftForReview() {
        calls.submit++;
        return {
          ok: true,
          value: {
            id: crypto.randomUUID(),
            status: "ready_for_review",
            summaryMd: "# Higher agency",
            operations: [{ type: "upsert_organized_goal", title: "Higher agency" }],
            sourceRefs: [],
            updatedAt: new Date().toISOString(),
          },
        };
      },
    };
    configureCollaborationMcpBackend(backend);

    const host = new CollaborationMcpHttpServer();
    const { client, transport } = await connect(host);

    const tools = await client.listTools();
    expect(tools.tools.map(tool => tool.name).sort()).toEqual([
      "follow_provenance",
      "get_draft_operation_contract",
      "get_workspace",
      "get_workspace_index",
      "read_entity_context",
      "read_workspace_context",
      "redeem_collaboration_code",
      "save_draft_change_set",
      "search_workspace_index",
      "submit_draft_for_review",
    ]);
    expect(tools.tools.some(tool => tool.name.includes("apply") || tool.name.includes("calendar"))).toBe(false);

    const unredeemed = await client.callTool({ name: "get_workspace", arguments: {} });
    expect(unredeemed.isError).toBe(true);

    const redeemed = await client.callTool({ name: "redeem_collaboration_code", arguments: { code: "ABCD-1234" } });
    expect(redeemed.isError).not.toBe(true);
    expect(text(redeemed)).toContain("higher agency");
    expect(text(redeemed)).toContain("do not invent a different organized goal");

    const index = await client.callTool({ name: "get_workspace_index", arguments: {} });
    expect(index.isError).not.toBe(true);
    expect(text(index)).toContain("Higher agency");

    const indexSearch = await client.callTool({ name: "search_workspace_index", arguments: { query: "agency" } });
    expect(indexSearch.isError).not.toBe(true);
    expect(text(indexSearch)).toContain("agency");

    // Goal conversations cannot pull group history; the server rejects this
    // before it reaches the backend context reader.
    const forbidden = await client.callTool({
      name: "read_workspace_context",
      arguments: { section: "groups" },
    });
    expect(forbidden.isError).toBe(true);
    expect(calls.read).toBe(0);

    const allowed = await client.callTool({
      name: "read_workspace_context",
      arguments: { section: "raw_evidence" },
    });
    expect(allowed.isError).not.toBe(true);
    expect(text(allowed)).toContain("raw_evidence");
    expect(calls.read).toBe(1);

    const saved = await client.callTool({
      name: "save_draft_change_set",
      arguments: {
        summary_md: "# Higher agency\n\nA user-authored direction.",
        operations: [{ type: "upsert_organized_goal", title: "Higher agency" }],
        source_refs: [],
      },
    });
    expect(saved.isError).not.toBe(true);
    expect(calls.save).toBe(1);

    const submitted = await client.callTool({ name: "submit_draft_for_review", arguments: {} });
    expect(submitted.isError).not.toBe(true);
    expect(calls.submit).toBe(1);

    // A session can never redeem a second workspace after the first one.
    const secondRedeem = await client.callTool({ name: "redeem_collaboration_code", arguments: { code: "WXYZ-9999" } });
    expect(secondRedeem.isError).toBe(true);

    await transport.terminateSession();
    expect(host.sessionCount).toBe(0);
    await client.close();
  });
});
