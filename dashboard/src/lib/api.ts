// Thin fetch client over the dream backend v2. Same-origin via the dev-server
// proxy in src/index.ts (prod: Vercel rewrite).

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  const res = await fetch(`/api${path}`, {
    ...init,
    headers,
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
  | "pending_detection"
  | "rant_candidate"
  | "rejected"
  | "idle"
  | "awaiting_distill"
  | "awaiting_review"
  | "awaiting_derive"
  | "derived";

export interface ConversationRow {
  id: string;
  title: string | null;
  source: string;
  createdAt: string;
  sourceCreatedAt: string | null;
  sourceUpdatedAt: string | null;
  slugDetected: boolean;
  rantVerdict: "candidate" | "not_candidate" | null;
  rantStatus: "proposed" | "accepted" | "rejected" | null;
  rantDetectedAt: string | null;
  detectorNote: string | null;
  distillRequested: boolean;
  distilledAt: string | null;
  extractionsReviewedAt: string | null;
  derivedAt: string | null;
  parseError: string | null;
  messageCount: number | null;
  pipelineState: PipelineState;
}

export interface Vitals {
  lastAcceptedRantAt: string | null;
  daysSinceLastRant: number | null;
  lastExtractionConfirmedAt: string | null;
  lastProposalResolvedAt: string | null;
  lastVisitAt: string | null;
  pendingCandidates: number;
  awaitingReadBack: number;
  pendingProposals: number;
  experiment: {
    running: { id: string; title: string; dayN: number; plannedDurationDays: number | null } | null;
    queueDepth: number;
    lastEndedAt: string | null;
    daysSinceEnded: number | null;
    actionableCoverage: {
      activeGroupCount: number;
      groupsWithoutRunning: { id: string; title: string }[];
      groupsWithoutApprovedActionable: { id: string; title: string }[];
    };
  };
}

export interface StrikeReport {
  total: number;
  rantStrikes: number;
  queueStrikes: number;
  paused: boolean;
  pausedUntil: string | null;
  pauseReason: string | null;
  armed: boolean;
  queueNudge: boolean;
  facts: { daysSinceLastRant: number | null; emptyQueueDays: number };
}

export interface WitnessRow {
  id: string;
  name: string;
  platform: "manual" | "imessage" | "telegram";
  handle: string | null;
  timezone: string;
  status: "invited" | "active" | "paused" | "removed";
  isPrimary: boolean;
  inviteCode: string | null;
  chatId: string | null;
  linkedAt: string | null;
  promptCadenceDays: number;
  goalIds: string[];
}

export interface ReviewWriteupRow {
  id: string;
  experimentId: string;
  draftMd: string | null;
  finalMd: string | null;
  status: "drafting" | "draft_ready" | "approved";
  approvedAt: string | null;
}

export interface OutboundRow {
  id: string;
  witnessId: string;
  kind: "review_share" | "experiment_announcement" | "random_prompt" | "strike_alert" | "duty_ping";
  bodyText: string;
  originalBodyText: string | null;
  contextJson: string | null;
  status: "pending_approval" | "approved" | "sent" | "failed" | "cancelled";
  notBefore: string | null;
  approvedAt: string | null;
  sentAt: string | null;
  createdAt: string;
}

export type ExtractionKind =
  | "goal_talk"
  | "habit_talk"
  | "environment_talk"
  | "experience_talk"
  | "project_talk"
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

export interface ProjectRow {
  id: string;
  title: string;
  note: string | null;
  origin: "derived" | "manual";
  createdAt: string;
  updatedAt: string;
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
  | "project_add"
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
  kind: "experience" | "purchase" | "setup" | "project" | "momentum";
  title: string;
  detail: string | null;
  status: "pending" | "scheduled" | "done" | "skipped";
  scheduleMode?: "calendar" | "none";
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
  kind?: "candidate" | "actionable";
  experimentGroupId?: string | null;
  weekOf?: string | null;
  reviewMd?: string | null;
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

export interface ProjectDetail extends ProjectRow {
  sources: EntityRef[];
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
  registry: { habits: number; environment: number; experiences: number; projects: number };
  experimentQueue: number;
  liveExperimentId: string | null;
  liveExperimentTitle: string | null;
  calendarConnected: boolean;
  lastDailyRunAt: string | null;
}

// --- organized layer + MCP collaboration ---
//
// These deliberately do not reuse the raw GoalRow/HabitRow/etc. types above.
// The organized feed is a user-authored layer over those raw rows, so keeping
// its response shapes separate prevents the legacy feed from accidentally
// treating raw proposal-derived state as curated state.

export type CollaborationMode =
  | "organized_goal"
  | "organized_habit"
  | "organized_environment"
  | "experiment_group"
  | "actionable_experiment"
  | "prioritize";

export type OrganizedDetailEntityType =
  | "organized_goal"
  | "organized_habit"
  | "organized_environment"
  | "experiment_group"
  | "actionable_experiment";

// A focus workspace has no standalone detail route, but it is a valid primary
// entity in collaboration records.
export type OrganizedPrimaryEntityType = OrganizedDetailEntityType | "current_focus";

export interface OrganizedSourceRef {
  entityType: string;
  entityId: string;
  // A draft's sourceRefs are intentionally ID-only. Feed/detail endpoints may
  // enrich them with a label for the dashboard.
  title?: string;
  note?: string;
  detail?: string | null;
  extractionCount?: number;
}

export interface OrganizedGoalRow {
  id: string;
  title: string;
  identityClause: string | null;
  synthesisMd: string | null;
  priorityRank: number | null;
  status: "active" | "sunset" | "archived";
  sourceCount?: number;
  sources?: OrganizedSourceRef[];
  createdAt: string;
  updatedAt: string;
}

export interface OrganizedRegistryRow {
  id: string;
  title: string;
  note: string | null;
  synthesisMd: string | null;
  status: "active" | "sunset" | "archived";
  sourceCount?: number;
  sources?: OrganizedSourceRef[];
  createdAt: string;
  updatedAt: string;
}

export interface ExperimentGroupTargetRow {
  id: string;
  kind: "habit" | "environment" | "experience" | "project";
  title: string;
  detailMd: string | null;
  status: "pending" | "done";
  doneAt: string | null;
}

/** Shallow lineage reference: enough for a breadcrumb + click-through. */
export interface ExperimentGroupLineageRef {
  id: string;
  title: string;
  status: "candidate" | "active" | "done" | "sunset" | "archived";
  archivedAt: string | null;
}

export interface ExperimentGroupRow {
  id: string;
  title: string;
  motivationMd: string | null;
  status: "candidate" | "active" | "done" | "sunset" | "archived";
  closingReviewMd: string | null;
  parentExperimentGroupId?: string | null;
  archivedAt?: string | null;
  archivedFromStatus?: "candidate" | "done" | "sunset" | null;
  parent?: ExperimentGroupLineageRef | null;
  children?: ExperimentGroupLineageRef[];
  goals: Pick<OrganizedGoalRow, "id" | "title" | "priorityRank" | "status">[];
  targets: ExperimentGroupTargetRow[];
  projectCount?: number;
  projects?: { id: string; title: string; note: string | null }[];
  contexts?: { id: string; textMd: string; createdAt: string }[];
  createdAt: string;
  updatedAt: string;
}

// There is at most one current focus.  Its goal list is already ordered by
// the reviewed priority decision, so the dashboard must render it as-is
// rather than attempting to sort or mutate it locally.
export interface CurrentFocusRow {
  id: string;
  entryReason: "pick" | "sunset";
  reasoningMd: string;
  startedAt: string;
  endedAt: string | null;
  group: ExperimentGroupRow;
  goals: Pick<OrganizedGoalRow, "id" | "title" | "priorityRank" | "status">[];
}

export interface ActionableExperimentRow {
  id: string;
  title: string;
  hypothesisMd: string | null;
  status: ExperimentStatus;
  kind: "actionable";
  experimentGroupId: string | null;
  weekOf: string | null;
  reviewMd: string | null;
  plannedDurationDays: number | null;
  startedAt: string | null;
  endedAt: string | null;
  groupTitle?: string | null;
  taskSummary?: { total: number; done: number; scheduled: number };
  tasks?: TaskRow[];
}

export interface OrganizedEntityDetail {
  entityType: OrganizedDetailEntityType;
  entity: OrganizedGoalRow | OrganizedRegistryRow | ExperimentGroupRow | ActionableExperimentRow;
  sources: OrganizedSourceRef[];
  extractions: CitedExtraction[];
}

export interface OrganizedFeedRow {
  goals: OrganizedGoalRow[];
  habits: OrganizedRegistryRow[];
  environment: OrganizedRegistryRow[];
  groups: ExperimentGroupRow[];
  /** Hidden from the default working list; shown in the explicit archive view. */
  archivedGroups?: ExperimentGroupRow[];
  archivedGroupCount?: number;
  actionables: ActionableExperimentRow[];
  currentFocus: CurrentFocusRow | null;
  /** Optional during rollout; history is read-only and newest-first. */
  focusHistory?: CurrentFocusRow[];
}

export type CollaborationWorkspaceStatus = "open" | "draft_ready" | "applied" | "rejected" | "expired";
export type DraftChangeSetStatus = "drafting" | "ready_for_review" | "applied" | "rejected" | "expired";

/** A quarantined branch draft from the persistent no-code companion. */
export interface CompanionBranchDraftRow {
  id: string;
  companionIdentityId: string;
  parentExperimentGroupId: string;
  userSeedMd: string;
  summaryMd: string;
  operations: unknown[];
  sourceRefs: { entityType: string; entityId: string; note?: string }[];
  audit: Record<string, unknown> | null;
  status: DraftChangeSetStatus;
  rejectionNote: string | null;
  appliedAt: string | null;
  rejectedAt: string | null;
  createdAt: string;
  updatedAt: string;
  parent?: ExperimentGroupLineageRef | null;
}

export interface CollaborationInviteRow {
  id: string;
  mode: CollaborationMode;
  primaryEntityType: OrganizedPrimaryEntityType | null;
  primaryEntityId: string | null;
  experimentGroupId?: string | null;
  prioritizeAction?: "pick" | "sunset" | null;
  userSeedMd: string | null;
  selectedOrganizedGoalIds: string[];
  expiresAt: string;
  redeemedAt: string | null;
  workspaceId: string | null;
  createdAt: string;
}

export interface CollaborationWorkspaceRow {
  id: string;
  inviteId: string;
  mode: CollaborationMode;
  status: CollaborationWorkspaceStatus;
  primaryEntityType: OrganizedPrimaryEntityType;
  primaryEntityId: string | null;
  experimentGroupId?: string | null;
  prioritizeAction?: "pick" | "sunset" | null;
  userSeedMd: string | null;
  selectedOrganizedGoalIds: string[];
  createdAt: string;
  updatedAt: string;
}

// Operations are intentionally transport-shaped. The dashboard must render
// them verbatim for review, while the backend validates and applies them
// transactionally. Keeping an open payload leaves room for every valid
// coordinated operation without letting the client invent new writes.
export interface DraftChangeSetOperation {
  type: string;
  [key: string]: unknown;
}

export interface DraftChangeSetRow {
  id: string;
  workspaceId: string;
  mode: CollaborationMode;
  primaryEntityType: OrganizedPrimaryEntityType;
  primaryEntityId: string | null;
  summaryMd: string;
  operations: DraftChangeSetOperation[];
  sourceRefs: OrganizedSourceRef[];
  audit?: Record<string, unknown> | null;
  status: DraftChangeSetStatus;
  rejectionNote: string | null;
  appliedAt: string | null;
  rejectedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CollaborationInviteStatus {
  invite: CollaborationInviteRow;
  workspace: CollaborationWorkspaceRow | null;
  changeSet: DraftChangeSetRow | null;
}

export interface CreateCollaborationInviteInput {
  mode: CollaborationMode;
  userSeedMd: string;
  primaryEntityType?: OrganizedPrimaryEntityType;
  primaryEntityId?: string;
  experimentGroupId?: string;
  prioritizeAction?: "pick" | "sunset";
  selectedOrganizedGoalIds?: string[];
}

export interface CreatedCollaborationInvite {
  invite: CollaborationInviteRow;
  code: string;
  dashboardCapability: string;
}

function collaborationCapabilityHeaders(capability: string): HeadersInit {
  return { "x-collaboration-capability": capability };
}

export const api = {
  visit: () => request<{ ok: boolean }>("/user/visit", { method: "POST" }),
  vitals: () => request<{ asOf: string; vitals: Vitals; strikes: StrikeReport }>("/vitals"),
  pauseStrikes: (days: number, reason?: string) =>
    request<{ pausedUntil: string }>("/strikes/pause", { method: "POST", body: JSON.stringify({ days, reason }) }),
  resumeStrikes: () => request<{ ok: boolean }>("/strikes/resume", { method: "POST", body: "{}" }),

  // --- witnesses ---
  witnesses: () => request<WitnessRow[]>("/witnesses"),
  inviteWitness: (fields: { name: string; handle?: string; timezone?: string; isPrimary?: boolean; goalIds?: string[] }) =>
    request<WitnessRow>("/witnesses", { method: "POST", body: JSON.stringify(fields) }),
  patchWitness: (id: string, patch: Partial<Pick<WitnessRow, "name" | "handle" | "timezone" | "status" | "promptCadenceDays">>) =>
    request<WitnessRow>(`/witnesses/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
  setWitnessGoals: (id: string, goalIds: string[]) =>
    request<{ ok: boolean; goalIds: string[] }>(`/witnesses/${id}/goals`, { method: "PUT", body: JSON.stringify({ goalIds }) }),
  setWitnessPrimary: (id: string) =>
    request<{ ok: boolean }>(`/witnesses/${id}/primary`, { method: "POST", body: "{}" }),
  witnessPreview: (id: string) => request<{ contextMd: string }>(`/witnesses/${id}/preview`),
  // Real group chats published by the messenger daemon on the always-on Mac.
  messengerGroups: () =>
    request<{ publishedAt: string | null; groups: { chatId: string; name: string | null; isArchived: boolean }[] }>(
      "/messaging/groups",
    ),
  linkWitnessChat: (id: string, chatId: string) =>
    request<{ ok: boolean }>(`/witnesses/${id}/link`, { method: "POST", body: JSON.stringify({ chatId }) }),
  unlinkWitnessChat: (id: string) =>
    request<{ ok: boolean }>(`/witnesses/${id}/unlink`, { method: "POST", body: "{}" }),
  removeWitness: (id: string) => request<{ ok: boolean }>(`/witnesses/${id}`, { method: "DELETE" }),

  // --- review writeups + outbox ---
  review: (experimentId: string) => request<ReviewWriteupRow>(`/reviews/${experimentId}`),
  generateReview: (experimentId: string) =>
    request<{ status: string; draftMd?: string; error?: string }>(`/reviews/${experimentId}/generate`, { method: "POST", body: "{}" }),
  patchReview: (experimentId: string, draftMd: string) =>
    request<ReviewWriteupRow>(`/reviews/${experimentId}`, { method: "PATCH", body: JSON.stringify({ draftMd }) }),
  approveReview: (experimentId: string, finalMd: string) =>
    request<{ ok: boolean; shares: Record<string, string> }>(`/reviews/${experimentId}/approve`, {
      method: "POST",
      body: JSON.stringify({ finalMd }),
    }),
  startReviewInterview: (experimentId: string) =>
    request<{ sessionId: string }>(`/reviews/${experimentId}/interview`, { method: "POST", body: "{}" }),
  finishReviewInterview: (sessionId: string) =>
    request<{ status: string; draftMd?: string }>(`/reviews/interview/${sessionId}/finish`, { method: "POST", body: "{}" }),
  l3Session: (id: string) =>
    request<{ session: { id: string; purpose: string; status: string; experimentId: string | null }; messages: ChatMessageRow[] }>(
      `/l3/sessions/${id}`,
    ),
  outbox: (status?: string) => request<OutboundRow[]>(`/outbox${status ? `?status=${status}` : ""}`),
  approveOutbound: (id: string, bodyText?: string) =>
    request<{ row: OutboundRow; flush: unknown }>(`/outbox/${id}/approve`, {
      method: "POST",
      body: JSON.stringify(bodyText !== undefined ? { bodyText } : {}),
    }),
  patchOutbound: (id: string, bodyText: string) =>
    request<OutboundRow>(`/outbox/${id}`, { method: "PATCH", body: JSON.stringify({ bodyText }) }),
  cancelOutbound: (id: string) => request<{ ok: boolean }>(`/outbox/${id}/cancel`, { method: "POST", body: "{}" }),

  // --- conversations + pipeline ---
  conversations: (params: { state?: string; q?: string; slugged?: string; rant?: string } = {}) => {
    const q = new URLSearchParams();
    if (params.state) q.set("state", params.state);
    if (params.q) q.set("q", params.q);
    if (params.slugged) q.set("slugged", params.slugged);
    if (params.rant) q.set("rant", params.rant);
    return request<{ conversations: ConversationRow[] }>(`/conversations?${q}`).then(r => r.conversations);
  },
  // The rant explorer's paged envelope (total included).
  conversationsPaged: (params: {
    page?: number;
    pageSize?: number;
    q?: string;
    rant?: string;
    verdict?: string;
    detected?: string;
  }) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") q.set(k, String(v));
    return request<{ page: number; pageSize: number; total: number; conversations: ConversationRow[] }>(
      `/conversations?${q}`,
    );
  },
  detectConversation: (id: string) =>
    request<{ processed: number; candidates: number; skipped: number }>(`/conversations/${id}/detect`, {
      method: "POST",
      body: "{}",
    }),
  runDetectLimited: (limit: number) =>
    request<{ processed: number; candidates: number; autoAccepted: number; remaining: number }>("/jobs/detect", {
      method: "POST",
      body: JSON.stringify({ limit }),
    }),

  // --- steering (the universal EDIT next to accept/deny) ---
  startSteer: (targetType: "distill" | "proposal" | "goal", targetId: string) =>
    request<{ sessionId: string; opener: string }>("/steer", {
      method: "POST",
      body: JSON.stringify({ targetType, targetId }),
    }),
  finishSteer: (sessionId: string) =>
    request<{ targetType: string; targetId: string; result: unknown }>(`/steer/${sessionId}/finish`, {
      method: "POST",
      body: "{}",
    }),
  cancelSteer: (sessionId: string) =>
    request<{ ok: boolean }>(`/steer/${sessionId}/cancel`, { method: "POST", body: "{}" }),
  conversation: (id: string) =>
    request<
      ConversationRow & {
        contentHash: string | null;
        messages: { role: string; content: string }[] | null;
        extractions: ExtractionRow[];
      }
    >(`/conversations/${id}`),
  requestDistill: (id: string) => request(`/conversations/${id}/request-distill`, { method: "POST", body: "{}" }),
  rantAccept: (id: string) =>
    request<{ ok: boolean; distill: unknown }>(`/conversations/${id}/rant-accept`, { method: "POST", body: "{}" }),
  rantReject: (id: string, note?: string) =>
    request<{ ok: boolean }>(`/conversations/${id}/rant-reject`, {
      method: "POST",
      body: JSON.stringify(note ? { note } : {}),
    }),
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

  // --- organized feed + MCP collaboration ---
  // The MCP never receives these dashboard apply endpoints. It can only redeem
  // a code and write a workspace draft through the dedicated server; the
  // dashboard is the one place a reviewed change set can be applied.
  organizedFeed: () => request<OrganizedFeedRow>("/organized/feed"),
  organizedDetail: (type: OrganizedDetailEntityType, id: string) =>
    request<OrganizedEntityDetail>(`/organized/${type}/${id}`),
  markExperimentGroupTarget: (groupId: string, targetId: string, done: boolean) =>
    request<ExperimentGroupTargetRow>(`/organized/groups/${groupId}/targets/${targetId}`, {
      method: "POST",
      body: JSON.stringify({ done }),
    }),
  // Archive hides a noncurrent group without deleting it or touching its
  // branches; restore returns it to its pre-archive state (never active).
  archiveExperimentGroup: (groupId: string) =>
    request<ExperimentGroupRow>(`/organized/groups/${groupId}/archive`, { method: "POST", body: "{}" }),
  restoreExperimentGroup: (groupId: string, restoreAs?: "candidate" | "done" | "sunset") =>
    request<ExperimentGroupRow>(`/organized/groups/${groupId}/restore`, {
      method: "POST",
      body: JSON.stringify(restoreAs ? { restoreAs } : {}),
    }),

  // --- persistent companion inbox ---
  // These routes are behind the companion's fail-closed reviewer identity;
  // in a private-local deployment they authenticate via the loopback peer.
  companionDrafts: () => request<CompanionBranchDraftRow[]>("/companion/drafts"),
  companionDraft: (id: string) => request<CompanionBranchDraftRow>(`/companion/drafts/${id}`),
  applyCompanionDraft: (id: string) =>
    request<{ ok: boolean; draft: CompanionBranchDraftRow; createdGroupId: string }>(`/companion/drafts/${id}/apply`, {
      method: "POST",
      body: "{}",
    }),
  rejectCompanionDraft: (id: string, input: { feedback?: string; returnToDrafting?: boolean } = {}) =>
    request<{ ok: boolean; draft: CompanionBranchDraftRow }>(`/companion/drafts/${id}/reject`, {
      method: "POST",
      body: JSON.stringify(input),
    }),

  createCollaborationInvite: (input: CreateCollaborationInviteInput) =>
    request<CreatedCollaborationInvite>("/collaboration/invites", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  collaborationInvite: (id: string, capability: string) =>
    request<CollaborationInviteStatus>(`/collaboration/invites/${id}`, { headers: collaborationCapabilityHeaders(capability) }),
  collaborationWorkspace: (id: string, capability: string) =>
    request<{ workspace: CollaborationWorkspaceRow; changeSet: DraftChangeSetRow | null }>(
      `/collaboration/workspaces/${id}`,
      { headers: collaborationCapabilityHeaders(capability) },
    ),
  changeSet: (id: string, capability: string) =>
    request<DraftChangeSetRow>(`/collaboration/change-sets/${id}`, { headers: collaborationCapabilityHeaders(capability) }),
  applyChangeSet: (id: string, capability: string) =>
    request<{ ok: boolean; changeSet: DraftChangeSetRow }>(`/collaboration/change-sets/${id}/apply`, {
      method: "POST",
      body: "{}",
      headers: collaborationCapabilityHeaders(capability),
    }),
  rejectChangeSet: (id: string, capability: string, input: { feedback?: string; returnToDrafting?: boolean } = {}) =>
    request<{ ok: boolean; changeSet: DraftChangeSetRow }>(`/collaboration/change-sets/${id}/reject`, {
      method: "POST",
      body: JSON.stringify(input),
      headers: collaborationCapabilityHeaders(capability),
    }),

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
  projects: () => request<ProjectRow[]>("/projects"),
  project: (id: string) => request<ProjectDetail>(`/projects/${id}`),

  // --- experiments ---
  experimentCandidates: () => request<ExperimentRow[]>("/experiments/candidates"),
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
  confirmActionableSchedule: (id: string) =>
    request<{ ok: boolean; error?: string; experiment?: ExperimentRow; calendarEvents?: number; pushed?: number }>(
      `/experiments/${id}/confirm-schedule`,
      { method: "POST", body: "{}" },
    ),
  endExperiment: (id: string, verdict: "succeeded" | "failed", outcomeMd?: string) =>
    request(`/experiments/${id}/end`, { method: "POST", body: JSON.stringify({ verdict, outcomeMd }) }),
  archiveExperiment: (id: string) => request(`/experiments/${id}/archive`, { method: "POST", body: "{}" }),
  patchTask: (taskId: string, status: TaskRow["status"]) =>
    request<TaskRow>(`/experiments/tasks/${taskId}`, { method: "PATCH", body: JSON.stringify({ status }) }),
  // --- experiment shaping (the in-app replacement for copy-paste prompts) ---
  startShaping: () => request<{ sessionId: string; opener: string }>("/shaping", { method: "POST", body: "{}" }),
  finishShaping: (sessionId: string) =>
    request<{ conversationId: string }>(`/shaping/${sessionId}/finish`, { method: "POST", body: "{}" }),
  cancelShaping: (sessionId: string) =>
    request<{ ok: boolean }>(`/shaping/${sessionId}/cancel`, { method: "POST", body: "{}" }),

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
  // ── review inbox (rework) ──────────────────────────────────────────────
  reviewList: (status?: string) => request<RecordChangeSet[]>(`/review${status ? `?status=${status}` : ""}`),
  reviewGet: (id: string) => request<RecordChangeSet>(`/review/${id}`),
  reviewReconcile: (id: string) => request(`/review/${id}/reconcile`, { method: "POST", body: "{}" }),
  reviewApply: (id: string, verdicts: Record<string, RecordVerdict>) =>
    request(`/review/${id}/apply`, { method: "POST", body: JSON.stringify({ verdicts }) }),
  reviewReject: (id: string, feedback: string | undefined, returnToDrafting: boolean) =>
    request(`/review/${id}/reject`, { method: "POST", body: JSON.stringify({ feedback, returnToDrafting }) }),
  // ── plan board (rework) ────────────────────────────────────────────────
  weeklyBoard: () => request<WeeklyBoard>("/organized/weekly"),
  dailyPlans: (limit = 7) => request<DailyPlanRow[]>(`/organized/daily?limit=${limit}`),
  toggleWeeklyItem: (id: string, done: boolean) =>
    request(`/organized/weekly/items/${id}`, { method: "PATCH", body: JSON.stringify({ done }) }),
  toggleDailyItem: (id: string, done: boolean) =>
    request(`/organized/daily/items/${id}`, { method: "PATCH", body: JSON.stringify({ done }) }),
  toggleGroupIdea: (membershipId: string, done: boolean) =>
    request(`/organized/group-ideas/${membershipId}`, { method: "PATCH", body: JSON.stringify({ done }) }),
  searchRecords: (query: string) =>
    request<Record<string, RecordSummary[]>>(`/organized/records${query ? `?query=${encodeURIComponent(query)}` : ""}`),
  recordDetail: (model: string, lineageId: string) => request<RecordDetail>(`/organized/records/${model}/${lineageId}`),
};

export type RecordSummary = { lineageId: string; versionId: string; version: number; title: string; description: string | null };

export type WeeklyBoard = {
  pick: { id: string; endDate: string | null; expired: boolean; groupLineageId: string } | null;
  plans: { id: string; weekOf: string | null; theme: string; description: string | null; items: { id: string; kind: string; text: string; doneAt: string | null }[] }[];
};

export type DailyPlanRow = {
  id: string;
  date: string;
  theme: string | null;
  description: string | null;
  items: { id: string; kind: string; text: string; doneAt: string | null; taskLineageId: string | null }[];
};

export type RecordDetail = {
  model: string;
  lineageId: string;
  head: Record<string, unknown>;
  versions: { id: string; version: number | null }[];
  relations: Record<string, unknown>;
  conversationSlices: { conversationId: string; title: string | null }[];
  rant: { conversationId: string; title: string | null; date: string | null; messages: { role: string; content: string }[] } | null;
};

// ── review inbox types (rework) ──────────────────────────────────────────
export type RecordVerdict =
  | { verdict: "new" }
  | { verdict: "version_bump"; ofLineageId: string }
  | { verdict: "link_existing"; lineageId: string }
  | { verdict: "remix"; parents: { model: string; versionId: string }[] };

export type RecordOperation =
  | { op: "create"; tempId: string; model: string; role: "central" | "satellite"; fields: Record<string, unknown> }
  | { op: "link"; relation: string; from: string; to: string; description?: string; rank?: number };

export type RecordChangeSet = {
  id: string;
  summaryMd: string;
  operations: RecordOperation[];
  reconciliation: {
    candidates?: Record<string, { lineageId: string; versionId: string; version: number; title: string; description: string | null }[]>;
    verdicts?: Record<string, RecordVerdict>;
    reasons?: Record<string, string>;
  } | null;
  appliedRecords: Record<string, { model: string; versionId: string; lineageId: string; verdict: string; role: string; title: string }> | null;
  markerToken: string | null;
  status: string;
  rejectionNote: string | null;
  submittedAt: string | null;
  appliedAt: string | null;
  rejectedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

// ── planning revamp: chains, runs, wins (NowBoard) ───────────────────────

export type ChainRunStepRow = {
  id: string;
  chainRunId: string;
  position: number;
  kind: "starter" | "warmup" | "core" | "reward";
  text: string;
  doneAt: string | null;
};

export type ChainMeta = {
  trigger: string;
  purpose: string | null;
  minimumVersion: string | null;
  rewardKind: string | null;
  rewardText: string | null;
} | null;

export type ChainRunView = {
  id: string;
  date: string;
  dailyPlanId: string | null;
  calendarEventId: string | null;
  startedAt: string | null;
  completedAt: string | null;
  minimumOnly: number;
  steps: ChainRunStepRow[];
  chain: ChainMeta;
};

export type RunSummary = {
  id: string;
  trigger: string | null;
  completedAt: string | null;
  minimumOnly: number;
  stepsDone: number;
  stepsTotal: number;
};

export type WinEntryRow = {
  id: string;
  date: string;
  kind: "action" | "created" | "courage" | "selfcare" | "identity" | "lesson" | "recognition";
  text: string;
  source: "auto" | "conversation";
  createdAt: string;
};

export type WinsPayload = {
  date?: string;
  weekOf?: string;
  from?: string;
  to?: string;
  entries: WinEntryRow[];
  byKind: Record<string, { text: string; date: string; source: string }[]>;
  runs: { armed: number; completed: number; minimum: number };
  perDay?: { date: string; count: number; runs: { armed: number; completed: number; minimum: number } }[];
  reviewed?: boolean;
};

export type NowPayload = {
  mode: "chain" | "idle";
  date: string;
  theme: string | null;
  topPriority: string | null;
  firstDomino: string | null;
  minimumViableDay: string | null;
  weekDirection: string | null;
  month: { theme: string | null; endDate: string | null } | null;
  winsToday: number;
  runsToday: RunSummary[];
  block?: { title: string; startAt: string; endAt: string };
  run?: {
    id: string;
    trigger: string | undefined;
    purpose: string | null | undefined;
    minimumVersion: string | null | undefined;
    reward: string | null | undefined;
    steps: ChainRunStepRow[];
    currentStepId: string | null;
  };
  nextCue?: { runId: string; title: string; startAt: string; minutesUntil: number } | null;
};

export type DailyPlanV2Row = {
  id: string;
  date: string;
  theme: string | null;
  description: string | null;
  topPriority: string | null;
  supportingHealth: string | null;
  supportingConnection: string | null;
  firstDomino: string | null;
  minimumViableDay: string | null;
  parkingLot: string[];
};

export type TodayPayload = {
  date: string;
  plan: DailyPlanV2Row | null;
  runs: ChainRunView[];
  wins: WinsPayload;
  unreviewedDays: string[];
};

export type WeekPayload = {
  week:
    | {
        id: string;
        weekOf: string;
        direction: string | null;
        theme: string | null;
        topOutcomes: string[];
        milestones: string[];
        healthPriority: string | null;
        socialPriority: string | null;
        maintenancePriority: string | null;
        fearToFace: string | null;
        failurePoints: { point: string; recovery: string }[];
        successDefinition: string | null;
        candidateMissions: string[];
        description: string | null;
      }
    | null;
  chains?: { lineageId: string; trigger: string; status: string }[];
  wins?: WinsPayload;
  month: { theme: string | null; endDate: string | null } | null;
};

export const plans = {
  now: () => request<NowPayload>("/plans/now"),
  today: (date?: string) => request<TodayPayload>(`/plans/today${date ? `?date=${date}` : ""}`),
  week: () => request<WeekPayload>("/plans/week"),
  wins: (scope: "day" | "week" | "month") => request<WinsPayload>(`/plans/wins?scope=${scope}`),
  toggleStep: (runId: string, stepId: string, done: boolean) =>
    request<ChainRunView>(`/plans/runs/${runId}/steps/${stepId}/toggle`, {
      method: "POST",
      body: JSON.stringify({ done }),
    }),
  minimumRun: (runId: string) => request<ChainRunView>(`/plans/runs/${runId}/minimum`, { method: "POST", body: "{}" }),
  adhocRun: (chainLineageId: string) =>
    request<ChainRunView>("/plans/runs/adhoc", { method: "POST", body: JSON.stringify({ chainLineageId }) }),
  addParking: (text: string) =>
    request<{ parkingLot: string[] }>("/plans/today/parking-lot", { method: "POST", body: JSON.stringify({ text }) }),
};
