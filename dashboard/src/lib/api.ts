// Thin fetch client over the dream backend v2. Same-origin via the dev-server
// proxy in src/index.ts (prod: Vercel rewrite).

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

export type PipelineState =
  | "parse_failed"
  | "idle"
  | "awaiting_distill"
  | "awaiting_review"
  | "awaiting_derive"
  | "derived";

export interface ConversationRow {
  id: string;
  title: string | null;
  sourceUpdatedAt: string | null;
  slugDetected: boolean;
  distillRequested: boolean;
  distilledAt: string | null;
  extractionsReviewedAt: string | null;
  derivedAt: string | null;
  parseError: string | null;
  pipelineState: PipelineState;
}

export type ExtractionKind =
  | "goal_talk"
  | "habit_talk"
  | "environment_talk"
  | "experience_talk"
  | "experiment_idea"
  | "feeling";

export interface ExtractionRow {
  id: string;
  conversationId: string;
  kind: ExtractionKind;
  text: string;
  startIdx: number | null;
  endIdx: number | null;
  contentHash: string;
  origin: "agent" | "manual";
  confirmedAt: string | null;
  createdAt: string;
}

export interface GoalRow {
  id: string;
  title: string;
  identityClause: string | null;
  synthesisMd: string | null;
  status: "active" | "backlog" | "dormant" | "succeeded" | "irrelevant";
  sortOrder: number;
  attemptCount: number; // the heatmap signal
  habits: { id: string; title: string; status: string }[];
  environmentItems: { id: string; title: string; subKind: string }[];
}

export interface HabitRow {
  id: string;
  title: string;
  note: string | null;
  valence: "good" | "bad";
  status: "established" | "building" | "lapsed";
  rrule: string | null;
  preferredTime: string | null;
  durationMinutes: number | null;
  experimentId: string | null;
}

export interface EnvironmentRow {
  id: string;
  title: string;
  note: string | null;
  subKind: "physical_setup" | "obligation" | "social";
  status: "active" | "removed";
}

export interface ExperienceRow {
  id: string;
  title: string;
  note: string | null;
  state: "planned" | "had";
  plannedFor: string | null;
  hadAt: string | null;
}

export type ProposalKind =
  | "goal_create"
  | "goal_update"
  | "synthesis_update"
  | "habit_add"
  | "habit_update"
  | "environment_add"
  | "environment_update"
  | "experience_add"
  | "experiment_propose";

// Extraction joined to its source conversation — the rant-source list.
export type CitedExtraction = ExtractionRow & {
  conversationTitle: string | null;
  conversationDate: string | null;
};

export interface ProposalRow {
  id: string;
  kind: ProposalKind;
  status: string;
  scopeKey: string;
  payload: any;
  createdAt: string;
  denialNote: string | null;
  citedExtractions: CitedExtraction[];
}

export type ExperimentStatus = "queued" | "scheduling" | "running" | "succeeded" | "failed" | "archived";

export interface TaskRow {
  id: string;
  experimentId: string;
  kind: "experience" | "purchase" | "setup";
  title: string;
  detail: string | null;
  status: "pending" | "scheduled" | "done" | "skipped";
  scheduledFor: string | null;
}

export interface ExperimentRow {
  id: string;
  title: string;
  hypothesisMd: string | null;
  status: ExperimentStatus;
  bandwidth: string | null;
  plannedDurationDays: number | null;
  queuedAt: string | null;
  startedAt: string | null;
  endedAt: string | null;
  outcomeMd: string | null;
}

export interface CurrentExperiment extends ExperimentRow {
  daysRunning: number | null;
  isRunning: boolean;
  tasks: TaskRow[];
  goalIds: string[];
}

// The experiment checklist: an experiment IS a set of scoped-out changes.
export interface ProposedChange {
  kind: "habit_change" | "experience" | "environment_change";
  title: string;
  detail: string;
  easier: string;
  why: string;
  extraction_ids?: string[];
}

export interface EntityRef {
  id: string;
  title: string;
  status: string;
}

export interface ExperimentRef extends EntityRef {
  startedAt: string | null;
  endedAt: string | null;
  outcomeMd: string | null;
}

export interface ExperimentDetail extends ExperimentRow {
  proposedChanges: ProposedChange[] | null;
  tasks: TaskRow[];
  goalIds: string[];
  goals: EntityRef[];
  habitsBorn: HabitRow[];
  experiences: ExperienceRow[];
  calendarEvents: CalendarEventRow[];
  extractions: CitedExtraction[];
}

export interface EvidenceNote {
  id: string;
  note: string | null;
  createdAt: string;
  conversationTitle: string | null;
}

export interface GoalDetail extends Omit<GoalRow, "habits" | "environmentItems"> {
  experiments: ExperimentRef[];
  idealHabits: HabitRow[];
  idealEnvironment: EnvironmentRow[];
  schedule: CalendarEventRow[];
  evidence: EvidenceNote[];
  pendingProposals: { id: string; kind: string; title: string }[];
  extractions: CitedExtraction[];
}

export interface HabitDetail extends HabitRow {
  goals: EntityRef[];
  bornInExperiment: ExperimentRef | null;
  calendarEvents: CalendarEventRow[];
  extractions: CitedExtraction[];
}

export interface EnvironmentDetail extends EnvironmentRow {
  goals: EntityRef[];
  calendarEvents: CalendarEventRow[];
  extractions: CitedExtraction[];
}

export interface ExperienceDetail extends ExperienceRow {
  fromExperiment: (ExperimentRef & { taskTitle: string }) | null;
  calendarEvents: CalendarEventRow[];
  extractions: CitedExtraction[];
}

export interface ChatMessageRow {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
}

export interface SchedulePlan {
  hypothesis_md: string;
  planned_duration_days: number;
  bandwidth: string;
  tasks: { kind: string; title: string; detail?: string; start: string; end: string }[];
  habit_blocks: {
    title: string;
    note?: string;
    rrule: string;
    preferred_time: string;
    duration_minutes: number;
    first_occurrence: string;
  }[];
}

export interface ChatSessionRow {
  id: string;
  experimentId: string | null;
  status: "open" | "committed" | "cancelled";
  plan: SchedulePlan | null;
  messages: ChatMessageRow[];
}

export interface CalendarEventRow {
  id: string;
  entityType: string;
  entityId: string;
  title: string;
  startAt: string;
  endAt: string;
  rrule: string | null;
  blockStyle: "habit" | "experiment" | "obligation" | "task";
  status: "active" | "cancelled" | "needs_reschedule";
}

export type AnchorKind = "wake_up" | "start_work" | "end_work" | "sleep";

export interface AnchorRow {
  id: string;
  kind: AnchorKind;
  date: string;
  at: string;
}

export interface RescheduleDiff {
  moved: { title: string; from: string; to: string }[];
  unplaced: { title: string }[];
}

export interface FreeTimeDay {
  date: string;
  segments: { start: string; end: string; minutes: number }[];
  totalMinutes: number;
}

export interface WriteupRow {
  date: string;
  text: string;
}

export interface EventRow {
  id: string;
  entityType: string;
  entityId: string | null;
  eventType: string;
  payloadJson: string | null;
  createdAt: string;
}

export interface HealthReport {
  ok: boolean;
  conversations: number;
  pipeline: { awaitingDistill: number; awaitingReview: number; awaitingDerive: number; derived: number };
  activeGoals: number;
  pendingProposals: number;
  registry: { habits: number; environment: number; experiences: number };
  experimentQueue: number;
  liveExperimentId: string | null;
  liveExperimentTitle: string | null;
  calendarConnected: boolean;
  lastDailyRunAt: string | null;
}

export const api = {
  visit: () => request<{ ok: boolean }>("/user/visit", { method: "POST" }),

  // --- conversations + pipeline ---
  conversations: (params: { state?: string; q?: string; slugged?: string } = {}) => {
    const q = new URLSearchParams();
    if (params.state) q.set("state", params.state);
    if (params.q) q.set("q", params.q);
    if (params.slugged) q.set("slugged", params.slugged);
    return request<{ conversations: ConversationRow[] }>(`/conversations?${q}`).then(r => r.conversations);
  },
  conversation: (id: string) =>
    request<
      ConversationRow & {
        contentHash: string | null;
        messages: { role: string; content: string }[] | null;
        extractions: ExtractionRow[];
      }
    >(`/conversations/${id}`),
  requestDistill: (id: string) => request(`/conversations/${id}/request-distill`, { method: "POST", body: "{}" }),
  confirmExtractions: (id: string) =>
    request<{ ok: boolean; confirmed: number; derive: unknown }>(`/conversations/${id}/confirm-extractions`, {
      method: "POST",
      body: "{}",
    }),
  redistill: (id: string) => request(`/conversations/${id}/redistill`, { method: "POST", body: "{}" }),
  rederive: (id: string) => request(`/conversations/${id}/rederive`, { method: "POST", body: "{}" }),

  // --- extractions (review curation) ---
  extractions: (conversationId?: string) =>
    request<ExtractionRow[]>(`/extractions${conversationId ? `?conversationId=${conversationId}` : ""}`),
  addExtraction: (fields: { conversationId: string; kind: ExtractionKind; text: string; startIdx?: number; endIdx?: number }) =>
    request<ExtractionRow>("/extractions", { method: "POST", body: JSON.stringify(fields) }),
  patchExtraction: (id: string, patch: { text?: string; kind?: ExtractionKind }) =>
    request<ExtractionRow>(`/extractions/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
  deleteExtraction: (id: string) => request(`/extractions/${id}`, { method: "DELETE" }),

  // --- proposals ---
  proposals: () => request<ProposalRow[]>("/proposals?status=pending"),
  allProposals: (status?: string) => request<ProposalRow[]>(`/proposals${status ? `?status=${status}` : ""}`),
  proposal: (id: string) => request<ProposalRow>(`/proposals/${id}`),
  reviseProposal: (id: string, conversationId: string, instruction?: string) =>
    request<ProposalRow>(`/proposals/${id}/revise`, {
      method: "POST",
      body: JSON.stringify({ conversationId, instruction }),
    }),
  approveProposal: (id: string) =>
    request<{ ok: boolean; notes: string[] }>(`/proposals/${id}/approve`, { method: "POST" }),
  denyProposal: (id: string, note?: string) =>
    request(`/proposals/${id}/deny`, { method: "POST", body: JSON.stringify({ note }) }),

  // --- goals ---
  goals: (status?: string) => request<GoalRow[]>(`/goals${status ? `?status=${status}` : ""}`),
  goal: (id: string) => request<GoalDetail>(`/goals/${id}`),
  patchGoalStatus: (id: string, status: string) =>
    request(`/goals/${id}`, { method: "PATCH", body: JSON.stringify({ status }) }),
  createGoal: (fields: { title: string; identityClause?: string }) =>
    request<{ goal: GoalRow; note?: string }>("/goals", { method: "POST", body: JSON.stringify(fields) }),
  reorderGoals: (orderedIds: string[]) =>
    request("/goals/reorder", { method: "POST", body: JSON.stringify({ orderedIds }) }),

  // --- registries ---
  habits: (status?: string) => request<HabitRow[]>(`/habits${status ? `?status=${status}` : ""}`),
  habit: (id: string) => request<HabitDetail>(`/habits/${id}`),
  patchHabit: (id: string, patch: Partial<Pick<HabitRow, "title" | "note" | "valence" | "status">>) =>
    request<HabitRow>(`/habits/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
  createHabit: (fields: { title: string; note?: string; valence?: string; status?: string }) =>
    request<HabitRow>("/habits", { method: "POST", body: JSON.stringify(fields) }),

  environment: (status?: string) =>
    request<EnvironmentRow[]>(`/environment${status ? `?status=${status}` : ""}`),
  environmentItem: (id: string) => request<EnvironmentDetail>(`/environment/${id}`),
  patchEnvironment: (id: string, patch: Partial<Pick<EnvironmentRow, "title" | "note" | "status">>) =>
    request<EnvironmentRow>(`/environment/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
  createEnvironment: (fields: { title: string; subKind: string; note?: string }) =>
    request<EnvironmentRow>("/environment", { method: "POST", body: JSON.stringify(fields) }),

  experiences: (state?: string) => request<ExperienceRow[]>(`/experiences${state ? `?state=${state}` : ""}`),
  experience: (id: string) => request<ExperienceDetail>(`/experiences/${id}`),
  createExperience: (fields: { title: string; note?: string; state?: string }) =>
    request<ExperienceRow>("/experiences", { method: "POST", body: JSON.stringify(fields) }),
  experienceHad: (id: string, note?: string) =>
    request<ExperienceRow>(`/experiences/${id}/had`, { method: "POST", body: JSON.stringify({ note }) }),

  // --- experiments ---
  experimentQueue: () => request<ExperimentRow[]>("/experiments/queue"),
  currentExperiment: () =>
    request<{ experiment: CurrentExperiment | null }>("/experiments/current").then(r => r.experiment),
  experimentHistory: () => request<ExperimentRow[]>("/experiments/history"),
  experiment: (id: string) => request<ExperimentDetail>(`/experiments/${id}`),
  pickExperiment: (id: string) =>
    request<{ ok: boolean; sessionId: string; error?: string }>(`/experiments/${id}/pick`, {
      method: "POST",
      body: "{}",
    }),
  endExperiment: (id: string, verdict: "succeeded" | "failed", outcomeMd?: string) =>
    request(`/experiments/${id}/end`, { method: "POST", body: JSON.stringify({ verdict, outcomeMd }) }),
  archiveExperiment: (id: string) => request(`/experiments/${id}/archive`, { method: "POST", body: "{}" }),
  patchTask: (taskId: string, status: TaskRow["status"]) =>
    request<TaskRow>(`/experiments/tasks/${taskId}`, { method: "PATCH", body: JSON.stringify({ status }) }),
  taskCopyPrompt: async (taskId: string) => {
    const res = await fetch(`/api/experiments/tasks/${taskId}/copy-prompt`);
    if (!res.ok) throw new ApiError(res.status, "copy prompt unavailable");
    return res.text();
  },
  experimentPrompt: async () => {
    const res = await fetch("/api/experiments/prompt");
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new ApiError(res.status, body.error ?? "prompt unavailable");
    }
    return res.text();
  },

  // --- schedule chat ---
  chatSession: (id: string) => request<ChatSessionRow>(`/chat/sessions/${id}`),
  chatSessionForExperiment: (experimentId: string) =>
    request<ChatSessionRow>(`/chat/sessions?experimentId=${experimentId}`),
  chatSend: (id: string, text: string) =>
    request<ChatSessionRow>(`/chat/sessions/${id}/messages`, { method: "POST", body: JSON.stringify({ text }) }),
  chatConfirm: (id: string) =>
    request<{ ok: boolean; error?: string }>(`/chat/sessions/${id}/confirm`, { method: "POST", body: "{}" }),
  chatCancel: (id: string) =>
    request<{ ok: boolean }>(`/chat/sessions/${id}/cancel`, { method: "POST", body: "{}" }),

  // --- calendar + anchors ---
  calendarStatus: () =>
    request<{ connected: boolean; dreamCalendarId: string | null; hasSyncToken: boolean }>("/calendar/status"),
  calendarAuthUrl: () => request<{ url: string }>("/calendar/auth/url"),
  calendarAuthToken: (code: string) =>
    request("/calendar/auth/token", { method: "POST", body: JSON.stringify({ code }) }),
  calendarSync: () => request("/calendar/sync", { method: "POST", body: "{}" }),
  calendarToday: () =>
    request<{ date: string; events: CalendarEventRow[]; needsReschedule: CalendarEventRow[]; anchors: AnchorRow[] }>(
      "/calendar/today",
    ),
  freeTime: (days = 7) =>
    request<{ connected: boolean; days: FreeTimeDay[] }>(`/calendar/free-time?days=${days}`),
  anchors: (date?: string) => request<AnchorRow[]>(`/anchors${date ? `?date=${date}` : ""}`),
  tapAnchor: (kind: AnchorKind) =>
    request<{ anchor: AnchorRow; reschedule: RescheduleDiff | null }>("/anchors", {
      method: "POST",
      body: JSON.stringify({ kind }),
    }),

  // --- writeup (demoted) + admin ---
  writeupToday: async (): Promise<WriteupRow | null> => {
    const res = await fetch("/api/writeup/today");
    if (!res.ok) return null;
    return res.json();
  },
  writeupHistory: () => request<WriteupRow[]>("/writeup/history"),
  events: (limit = 50) => request<EventRow[]>(`/events?limit=${limit}`),
  health: () => request<HealthReport>("/admin/health"),
  config: () => request<Record<string, unknown>>("/config"),
  patchConfig: (patch: Record<string, unknown>) =>
    request<Record<string, unknown>>("/config", { method: "PATCH", body: JSON.stringify(patch) }),
  reset: () => request("/admin/reset", { method: "POST", body: JSON.stringify({ confirm: "RESET" }) }),
  seedConfig: () => request("/admin/seed-config", { method: "POST", body: "{}" }),
  importFile: async (file: File) => {
    const form = new FormData();
    form.append("file", file);
    const res = await fetch("/api/admin/import", { method: "POST", body: form });
    const body = await res.json();
    if (!res.ok) throw new ApiError(res.status, body.error ?? "import failed");
    return body as { new: number; updated: number; unchanged: number; errors: unknown[] };
  },
  runDaily: () => request("/jobs/daily", { method: "POST", body: "{}" }),
  runDistill: () => request("/jobs/distill", { method: "POST", body: "{}" }),
  runDerive: (conversationId?: string) =>
    request("/jobs/derive", { method: "POST", body: JSON.stringify(conversationId ? { conversationId } : {}) }),
  runWriteup: () => request("/jobs/writeup", { method: "POST", body: "{}" }),
};
