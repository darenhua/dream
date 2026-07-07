// Thin fetch client over the dream backend (§9 contract). Same-origin via the
// dev-server proxy in src/index.ts.

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    headers: init?.body ? { "content-type": "application/json" } : undefined,
    ...init,
  });
  if (!res.ok) {
    let detail = "";
    try {
      const body = await res.json();
      detail = body.error ?? JSON.stringify(body);
    } catch {
      detail = res.statusText;
    }
    throw new ApiError(res.status, detail);
  }
  return (await res.json()) as T;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

// --- backend row shapes (subset the dashboard consumes) ---

export interface GoalRow {
  id: string;
  categoryId: string | null;
  title: string;
  identityClause: string | null;
  synthesisMd: string | null;
  status: "suggested" | "active" | "backlog" | "dormant" | "retired";
  sortOrder: number;
}

export interface RegistryRow {
  id: string;
  kind: "habit" | "environment" | "experience";
  title: string;
  note: string | null;
  valence: "good" | "bad" | null;
  status: "proposed" | "active" | "removed";
}

export interface ProposalRow {
  id: string;
  kind:
    | "categorization"
    | "goal_create"
    | "goal_update"
    | "goal_status"
    | "registry_add"
    | "registry_prune"
    | "synthesis_update";
  status: string;
  scopeKey: string;
  payload: any;
}

export interface LinkRow {
  id: string;
  categoryId: string;
  categoryName: string;
  activeForDerive: boolean;
  pinned: boolean;
}

export interface ConversationRow {
  id: string;
  title: string | null;
  sourceUpdatedAt: string | null;
  slugDetected: boolean;
  links: LinkRow[];
}

export interface CategoryRow {
  id: string;
  name: string;
  description: string | null;
  status: "active" | "archived";
}

export interface ExperimentRow {
  id: string;
  title: string;
  reasoningMd: string | null;
  actionsJson: string;
  bandwidth: string;
  status: "draft" | "committed" | "running" | "done" | "composted";
  daysRunning: number | null;
  isLive: boolean;
}

export interface WriteupRow {
  date: string;
  text: string;
}

export const api = {
  visit: () => request<{ ok: boolean }>("/user/visit", { method: "POST" }),

  goals: (status?: string) => request<GoalRow[]>(`/goals${status ? `?status=${status}` : ""}`),
  patchGoalStatus: (id: string, status: string) =>
    request(`/goals/${id}`, { method: "PATCH", body: JSON.stringify({ status }) }),

  registry: (kind?: string, status?: string) => {
    const q = new URLSearchParams();
    if (kind) q.set("kind", kind);
    if (status) q.set("status", status);
    return request<RegistryRow[]>(`/registry?${q}`);
  },
  patchRegistry: (id: string, patch: { status?: string; note?: string }) =>
    request(`/registry/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),

  proposals: () => request<ProposalRow[]>("/proposals?status=pending"),
  approveProposal: (id: string) =>
    request<{ ok: boolean; notes: string[] }>(`/proposals/${id}/approve`, { method: "POST" }),
  denyProposal: (id: string, note?: string) =>
    request(`/proposals/${id}/deny`, { method: "POST", body: JSON.stringify({ note }) }),

  conversations: () =>
    request<{ conversations: ConversationRow[] }>("/conversations").then(r => r.conversations),
  conversation: (id: string) =>
    request<ConversationRow & { messages: { role: string; content: string }[] | null }>(
      `/conversations/${id}`,
    ),
  categories: () => request<CategoryRow[]>("/categories?status=active"),
  linkConversation: (conversationId: string, categoryId: string) =>
    request(`/conversations/${conversationId}/links`, {
      method: "POST",
      body: JSON.stringify({ categoryId }),
    }),
  unlinkConversation: (conversationId: string, categoryId: string) =>
    request(`/conversations/${conversationId}/links/${categoryId}`, { method: "DELETE" }),
  patchLink: (linkId: string, activeForDerive: boolean) =>
    request(`/rant-links/${linkId}`, {
      method: "PATCH",
      body: JSON.stringify({ active_for_derive: activeForDerive }),
    }),

  importFile: async (file: File) => {
    const form = new FormData();
    form.append("file", file);
    const res = await fetch("/api/admin/import", { method: "POST", body: form });
    const body = await res.json();
    if (!res.ok) throw new ApiError(res.status, body.error ?? "import failed");
    return body as { new: number; updated: number; unchanged: number; errors: unknown[] };
  },

  runCategorize: () => request("/jobs/categorize", { method: "POST", body: "{}" }),
  runDerive: (categoryId?: string) =>
    request("/jobs/derive", { method: "POST", body: JSON.stringify(categoryId ? { categoryId } : {}) }),
  runDaily: () => request("/jobs/daily", { method: "POST", body: "{}" }),

  currentExperiment: () =>
    request<{ experiment: ExperimentRow | null }>("/experiment/current").then(r => r.experiment),
  promptPackage: async () => {
    const res = await fetch("/api/experiment/prompt-package");
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new ApiError(res.status, body.error ?? "package unavailable");
    }
    return res.text();
  },
  createDraft: async (pastedJson: string) => {
    const res = await fetch("/api/experiment/draft", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pastedJson }),
    });
    const body = await res.json();
    if (!res.ok) return { ok: false as const, fieldErrors: (body.fieldErrors ?? {}) as Record<string, string[]> };
    return { ok: true as const, experiment: body as { id: string } };
  },
  commitExperiment: (id: string) => request(`/experiment/${id}/commit`, { method: "POST" }),
  endExperiment: (id: string, verdict: "done" | "composted", note?: string) =>
    request(`/experiment/${id}/end`, {
      method: "POST",
      body: JSON.stringify(
        verdict === "composted"
          ? { verdict, compost_why: note }
          : { verdict, outcome_md: note },
      ),
    }),

  writeupToday: async (): Promise<WriteupRow | null> => {
    const res = await fetch("/api/writeup/today");
    if (!res.ok) return null;
    return res.json();
  },
};
