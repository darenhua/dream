import { Hono } from "hono";
import { getL3Session, streamTurn } from "../../services/l3Chat";

// L3 conversations: assistant-ui's AI SDK runtime posts the full UIMessage
// history; the server persists its own copy, so only the newest user text is
// taken from the request.
export const l3Routes = new Hono();

l3Routes.get("/sessions/:id", c => {
  const found = getL3Session(c.req.param("id"));
  if (!found) return c.json({ error: "session not found" }, 404);
  return c.json(found);
});

function lastUserText(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const b = body as Record<string, unknown>;
  if (typeof b.text === "string") return b.text; // simple shape
  if (Array.isArray(b.messages)) {
    const last = [...b.messages].reverse().find(m => m?.role === "user");
    if (!last) return null;
    if (typeof last.content === "string") return last.content;
    if (Array.isArray(last.parts)) {
      return last.parts
        .filter((p: { type?: string }) => p?.type === "text")
        .map((p: { text?: string }) => p.text ?? "")
        .join("");
    }
  }
  return null;
}

l3Routes.post("/sessions/:id/stream", async c => {
  const body = await c.req.json().catch(() => ({}));
  const text = lastUserText(body);
  if (!text || !text.trim()) return c.json({ error: "no user message in request" }, 400);
  try {
    return streamTurn(c.req.param("id"), text);
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
  }
});
