// Tiny typed client for the dream backend's wire API. The daemon is a dumb
// pipe: every decision (approval, quiet hours, copy, routing) lives backend-
// side; this file only moves JSON.

const BASE = process.env.BACKEND_URL ?? "http://localhost:3001";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}/api/messaging${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });
  if (!res.ok) throw new Error(`${path} → ${res.status} ${await res.text().catch(() => "")}`);
  return res.json() as Promise<T>;
}

export interface SendableRow {
  id: string;
  chatId: string;
  kind: string;
  bodyText: string;
}

export interface PublishedGroup {
  chatId: string;
  name: string | null;
  isArchived: boolean;
}

export const backend = {
  sendable: () => request<SendableRow[]>("/outbound/sendable"),
  markSent: (id: string, transportMessageId: string) =>
    request(`/outbound/${id}/sent`, { method: "POST", body: JSON.stringify({ transportMessageId }) }),
  markFailed: (id: string, error: string) =>
    request(`/outbound/${id}/failed`, { method: "POST", body: JSON.stringify({ error }) }),
  // The link picker's source of truth: real groups from this Mac's Messages.app.
  publishGroups: (groups: PublishedGroup[]) =>
    request("/groups", { method: "POST", body: JSON.stringify({ groups }) }),
  inbound: (e: { chatId: string; senderHandle: string; text: string; sentAt?: string; messageId?: string }) =>
    request<{ action: string }>("/inbound", { method: "POST", body: JSON.stringify(e) }),
};
