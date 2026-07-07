// Claude export parser — pure functions, no I/O. Spec'd from the real export file (A6/A6a/A6b).

export const ROOT_SENTINEL = "00000000-0000-4000-8000-000000000000";

export interface TranscriptMessage {
  role: "user" | "assistant";
  content: string;
  ts: string | null;
}

export interface ParsedConversation {
  externalId: string;
  title: string | null;
  sourceCreatedAt: string | null;
  sourceUpdatedAt: string | null;
  messages: TranscriptMessage[];
}

export class ParseError extends Error {
  constructor(
    public reason: string,
    public externalId: string | null,
  ) {
    super(reason);
  }
}

interface RawMessage {
  uuid: string;
  sender: "human" | "assistant";
  text?: string;
  created_at?: string;
  parent_message_uuid?: string;
  attachments?: { file_name?: string; extracted_content?: string }[];
}

// A6a — chat_messages is a tree (edits/regens create sibling branches); the visible
// transcript is the path from the latest leaf back to the root.
export function reconstructActivePath(chatMessages: RawMessage[]): RawMessage[] {
  if (chatMessages.length === 0) return [];
  const byUuid = new Map<string, RawMessage>();
  const isParent = new Set<string>();
  for (const m of chatMessages) {
    if (!m.uuid) throw new ParseError("message missing uuid", null);
    byUuid.set(m.uuid, m);
  }
  for (const m of chatMessages) {
    if (m.parent_message_uuid) isParent.add(m.parent_message_uuid);
  }
  const leaves = chatMessages.filter(m => !isParent.has(m.uuid));
  if (leaves.length === 0) throw new ParseError("no leaf message (cycle in message tree)", null);
  const latestLeaf = leaves.reduce((a, b) =>
    (b.created_at ?? "") > (a.created_at ?? "") ? b : a,
  );

  const path: RawMessage[] = [];
  const visited = new Set<string>();
  let current: RawMessage | undefined = latestLeaf;
  while (current) {
    if (visited.has(current.uuid)) throw new ParseError("cycle in message tree", null);
    visited.add(current.uuid);
    path.push(current);
    const parentUuid = current.parent_message_uuid;
    if (!parentUuid || parentUuid === ROOT_SENTINEL) break;
    current = byUuid.get(parentUuid);
    if (!current) throw new ParseError(`broken parent chain at ${parentUuid}`, null);
  }
  return path.reverse();
}

// A6b — `text` is authoritative for the visible transcript; attachments' extracted
// content is appended in marked blocks (rants lean on pasted context).
export function assembleContent(message: RawMessage): string {
  let content = message.text ?? "";
  for (const att of message.attachments ?? []) {
    if (att.extracted_content) {
      content += `\n\n[attachment: ${att.file_name ?? "unnamed"}]\n${att.extracted_content}`;
    }
  }
  return content;
}

export function parseConversation(raw: any): ParsedConversation {
  const externalId = raw?.uuid;
  if (!externalId || typeof externalId !== "string") {
    throw new ParseError("conversation missing uuid", null);
  }
  if (!Array.isArray(raw.chat_messages)) {
    throw new ParseError("conversation missing chat_messages array", externalId);
  }
  try {
    const path = reconstructActivePath(raw.chat_messages as RawMessage[]);
    const messages: TranscriptMessage[] = path.map(m => ({
      role: m.sender === "human" ? "user" : "assistant",
      content: assembleContent(m),
      ts: m.created_at ?? null,
    }));
    return {
      externalId,
      title: raw.name ?? null,
      sourceCreatedAt: raw.created_at ?? null,
      sourceUpdatedAt: raw.updated_at ?? null,
      messages,
    };
  } catch (e) {
    if (e instanceof ParseError) throw new ParseError(e.reason, externalId);
    throw new ParseError(e instanceof Error ? e.message : String(e), externalId);
  }
}

// A5 — the slug is typed as its own user message; exact match after trim, first wins.
// Analysis reads everything strictly BEFORE slugMessageIdx.
export function detectSlug(
  messages: TranscriptMessage[],
  slug: string,
): { slugDetected: boolean; slugMessageIdx: number | null } {
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!;
    if (m.role === "user" && m.content.trim() === slug) {
      return { slugDetected: true, slugMessageIdx: i };
    }
  }
  return { slugDetected: false, slugMessageIdx: null };
}
