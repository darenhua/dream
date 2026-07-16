import { describe, expect, test } from "bun:test";
import { createBackendRequestHandler, startBackendServer } from "../src/api/httpServer";

describe("backend HTTP server factory", () => {
  test("routes both MCP endpoints with the trusted peer address", async () => {
    let peerAddress: string | undefined;
    let companionPeer: string | undefined;
    const handle = createBackendRequestHandler({
      application: {
        fetch: () => new Response("application"),
      },
      mcpHttpHandler: {
        handle: (_request, peer) => {
          peerAddress = peer;
          return new Response("mcp");
        },
      },
      companionMcpHttpHandler: {
        handle: (_request, peer) => {
          companionPeer = peer;
          return new Response("companion");
        },
      },
    });

    expect(await (await handle(new Request("http://dream.test/api/health"))).text()).toBe("application");
    expect(await (await handle(new Request("http://dream.test/mcp"), "203.0.113.7")).text()).toBe("mcp");
    expect(peerAddress).toBe("203.0.113.7");
    expect(await (await handle(new Request("http://dream.test/companion-mcp"), "127.0.0.1")).text()).toBe("companion");
    expect(companionPeer).toBe("127.0.0.1");
  });

  test("stamps the companion inbox peer header from the socket and strips spoofed values", async () => {
    let seenPeerHeader: string | null | undefined;
    const handle = createBackendRequestHandler({
      application: {
        fetch: request => {
          seenPeerHeader = request.headers.get("x-dream-peer-address");
          return new Response("application");
        },
      },
      mcpHttpHandler: { handle: () => new Response("mcp") },
      companionMcpHttpHandler: { handle: () => new Response("companion") },
    });

    // A spoofed inbound header is replaced by the actual socket peer.
    await handle(
      new Request("http://dream.test/api/companion/drafts", { headers: { "x-dream-peer-address": "127.0.0.1" } }),
      "203.0.113.7",
    );
    expect(seenPeerHeader).toBe("203.0.113.7");

    // Without a socket peer, the spoofed header is stripped entirely.
    await handle(new Request("http://dream.test/api/companion/drafts", { headers: { "x-dream-peer-address": "127.0.0.1" } }));
    expect(seenPeerHeader).toBeNull();

    // Non-companion API paths keep their headers untouched.
    seenPeerHeader = undefined;
    await handle(new Request("http://dream.test/api/health"), "203.0.113.7");
    expect(seenPeerHeader).toBeNull();
  });

  test("starts on an ephemeral localhost port and stops cleanly", async () => {
    let peerAddress: string | undefined;
    const server = startBackendServer({
      hostname: "127.0.0.1",
      port: 0,
      application: {
        fetch: () => new Response("application"),
      },
      mcpHttpHandler: {
        handle: (_request, peer) => {
          peerAddress = peer;
          return new Response("mcp");
        },
      },
    });

    try {
      expect(server.port).toBeGreaterThan(0);

      const response = await fetch(`http://127.0.0.1:${server.port}/mcp`);
      expect(await response.text()).toBe("mcp");
      expect(peerAddress).toBeTruthy();
    } finally {
      await server.stop(true);
    }
  });
});
