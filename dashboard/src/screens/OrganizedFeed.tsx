import { useEffect, useMemo, useState } from "react";
import { CalendarCheck, CalendarDays, Check, GripVertical, ListChecks, Pencil, Plus, Sparkles, X } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { CollaborationDialog, type CollaborationLaunch } from "@/components/CollaborationDialog";
import { DetailModal } from "@/components/DetailModal";
import {
  api,
  type ActionableExperimentRow,
  type CollaborationInviteStatus,
  type CollaborationMode,
  type ExperimentGroupRow,
  type OrganizedEntityDetail,
  type OrganizedFeedRow,
  type OrganizedGoalRow,
  type OrganizedPrimaryEntityType,
  type OrganizedRegistryRow,
} from "@/lib/api";
import { useApiData } from "@/lib/useApiData";
import { cn } from "@/lib/utils";

const EMPTY_FEED: OrganizedFeedRow = {
  goals: [],
  habits: [],
  environment: [],
  groups: [],
  actionables: [],
};

type DetailTarget = { type: OrganizedPrimaryEntityType; id: string };
type RawSourceTarget = {
  entityType: "goal" | "habit" | "environment_item" | "experience" | "experiment" | "project";
  entityId: string;
};
type GoalList = "priority" | "out";
type TrackedCollaborationInvite = { id: string; dashboardCapability: string };

const COLLABORATION_INVITES_STORAGE_KEY = "dream-coach:collaboration-invites:v1";

function loadTrackedInvites(): TrackedCollaborationInvite[] {
  if (typeof window === "undefined") return [];
  try {
    const parsed = JSON.parse(window.localStorage.getItem(COLLABORATION_INVITES_STORAGE_KEY) ?? "[]") as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is TrackedCollaborationInvite =>
        typeof item === "object" && item !== null && "id" in item && "dashboardCapability" in item &&
        typeof item.id === "string" && typeof item.dashboardCapability === "string",
    );
  } catch {
    return [];
  }
}

function persistTrackedInvites(invites: TrackedCollaborationInvite[]) {
  if (typeof window !== "undefined") {
    window.localStorage.setItem(COLLABORATION_INVITES_STORAGE_KEY, JSON.stringify(invites));
  }
}

function modeTitle(mode: CollaborationMode) {
  return mode.replaceAll("_", " ");
}

function collaborationPhase(status: CollaborationInviteStatus) {
  if (status.changeSet?.status === "ready_for_review") return "ready for your review";
  if (status.changeSet?.status === "drafting") return "MCP is drafting";
  if (status.workspace) return "MCP workspace connected";
  return "waiting for MCP connection";
}

function isOpenCollaboration(status: CollaborationInviteStatus) {
  if (status.changeSet?.status === "applied" || status.changeSet?.status === "rejected") return false;
  if (status.workspace?.status === "applied" || status.workspace?.status === "rejected" || status.workspace?.status === "expired") return false;
  // An unredeemed code is no longer useful after expiry. Once redeemed, its
  // workspace remains reviewable even if the copy-friendly OTP has expired.
  return Boolean(status.workspace) || new Date(status.invite.expiresAt).getTime() > Date.now();
}

function sortedGoals(goals: OrganizedGoalRow[]) {
  return [...goals].sort((a, b) => {
    const rankA = a.priorityRank ?? Number.POSITIVE_INFINITY;
    const rankB = b.priorityRank ?? Number.POSITIVE_INFINITY;
    return rankA - rankB || a.title.localeCompare(b.title);
  });
}

function launchKey() {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

// This is intentionally a separate page from MainFeed. The existing raw feed
// remains the place for intake, approved proposal-derived rows, and operational
// legacy controls; this page renders only user-authored organized state.
export function OrganizedFeed({ tick, onChanged }: { tick: number; onChanged: () => void }) {
  const { data, loading, error, refresh } = useApiData(() => api.organizedFeed(), [tick]);
  const [trackedInvites, setTrackedInvites] = useState<TrackedCollaborationInvite[]>(loadTrackedInvites);
  const { data: trackedInviteStatuses, refresh: refreshTrackedInvites } = useApiData(
    async () => {
      const statuses = await Promise.all(
        trackedInvites.map(async tracked => {
          try {
            return { tracked, status: await api.collaborationInvite(tracked.id, tracked.dashboardCapability) };
          } catch {
            // A deliberately capability-scoped dashboard cannot enumerate
            // someone else's drafts. Omit an inaccessible record from this
            // view; its browser-held capability is never widened or replaced.
            return null;
          }
        }),
      );
      return statuses.filter((status): status is NonNullable<typeof status> => status !== null);
    },
    [tick, trackedInvites],
  );

  // The MCP can redeem and submit after this page's original invite modal has
  // closed. Poll only the browser-owned invite capabilities so the feed can
  // surface that transition without inventing a draft or enumerating anyone
  // else's collaboration state.
  useEffect(() => {
    if (trackedInvites.length === 0) return;
    const interval = window.setInterval(() => void refreshTrackedInvites(), 3_000);
    return () => window.clearInterval(interval);
  }, [trackedInvites.length, refreshTrackedInvites]);
  const [launch, setLaunch] = useState<CollaborationLaunch | null>(null);
  const [detailTarget, setDetailTarget] = useState<DetailTarget | null>(null);
  const [rawDetailTarget, setRawDetailTarget] = useState<RawSourceTarget | null>(null);
  const [sourceConversationId, setSourceConversationId] = useState<string | null>(null);
  const [draggedGoalId, setDraggedGoalId] = useState<string | null>(null);
  const [priorityBusy, setPriorityBusy] = useState(false);
  const [priorityError, setPriorityError] = useState<string | null>(null);

  const openCollaborations = useMemo(
    () =>
      (trackedInviteStatuses ?? []).filter(({ status }) => isOpenCollaboration(status)),
    [trackedInviteStatuses],
  );

  const feed = data ?? EMPTY_FEED;
  const activeGoals = useMemo(() => sortedGoals(feed.goals.filter(goal => goal.status === "active")), [feed.goals]);
  const priorityGoals = useMemo(() => activeGoals.filter(goal => goal.priorityRank !== null), [activeGoals]);
  const outOfPriorityGoals = useMemo(() => activeGoals.filter(goal => goal.priorityRank === null), [activeGoals]);
  const sunsetGoals = useMemo(() => feed.goals.filter(goal => goal.status === "sunset"), [feed.goals]);

  const openLaunch = (next: Omit<CollaborationLaunch, "key">) => setLaunch({ ...next, key: launchKey() });
  const changed = () => {
    onChanged();
    void refresh();
    void refreshTrackedInvites();
  };
  const trackInvite = (tracked: TrackedCollaborationInvite) => {
    setTrackedInvites(current => {
      const next = [...current.filter(item => item.id !== tracked.id), tracked];
      persistTrackedInvites(next);
      return next;
    });
  };

  const moveGoal = async (destination: GoalList, beforeId?: string) => {
    if (!draggedGoalId || priorityBusy) return;
    const priorityIds = priorityGoals.map(goal => goal.id).filter(id => id !== draggedGoalId);
    const outIds = outOfPriorityGoals.map(goal => goal.id).filter(id => id !== draggedGoalId);
    const target = destination === "priority" ? priorityIds : outIds;
    const insertAt = beforeId ? target.indexOf(beforeId) : -1;
    target.splice(insertAt >= 0 ? insertAt : target.length, 0, draggedGoalId);

    setPriorityBusy(true);
    setPriorityError(null);
    try {
      await api.reorderOrganizedGoalPriority(priorityIds, outIds);
      await refresh();
    } catch (cause) {
      setPriorityError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPriorityBusy(false);
      setDraggedGoalId(null);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-medium">organized feed</h2>
          <p className="text-sm text-muted-foreground">
            Your deliberately named directions and change work. Raw proposals and evidence stay in the current feed.
          </p>
        </div>
        <Badge variant="outline">user-authored layer</Badge>
      </div>

      {error && (
        <p className="rounded-lg border border-destructive/50 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          Could not load organized state: {error}
        </p>
      )}
      {priorityError && (
        <p className="rounded-lg border border-destructive/50 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          Could not update priority: {priorityError}
        </p>
      )}

      {openCollaborations.length > 0 && (
        <Card className="border-amber-300 bg-amber-50/60 py-4 dark:border-amber-900 dark:bg-amber-950/30">
          <CardHeader className="px-4">
            <div className="flex items-center justify-between gap-3">
              <CardTitle className="flex items-center gap-2 text-base font-medium">
                <Sparkles className="size-4" /> MCP collaboration workspaces
              </CardTitle>
              <Badge variant="outline">{openCollaborations.length}</Badge>
            </div>
          </CardHeader>
          <CardContent className="flex flex-col gap-2 px-4">
            {openCollaborations.map(({ tracked, status }) => (
              <button
                key={status.invite.id}
                className="flex items-center justify-between gap-3 rounded-lg border bg-background px-3 py-2 text-left hover:bg-muted/50"
                onClick={() =>
                  openLaunch({
                    mode: status.invite.mode,
                    title: `${collaborationPhase(status)} · ${modeTitle(status.invite.mode)}`,
                    inviteId: status.invite.id,
                    changeSetId: status.changeSet?.id,
                    dashboardCapability: tracked.dashboardCapability,
                  })
                }
              >
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium">
                    {status.changeSet?.summaryMd.split("\n")[0] || status.invite.userSeedMd || "MCP collaboration"}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {status.changeSet ? `${status.changeSet.operations.length} coordinated change${status.changeSet.operations.length === 1 ? "" : "s"}` : "The dashboard is waiting; it will not create anything on its own."}
                  </span>
                </span>
                <Badge variant={status.changeSet?.status === "ready_for_review" ? "secondary" : "outline"}>{collaborationPhase(status)}</Badge>
              </button>
            ))}
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card className="py-4">
          <CardHeader className="px-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <CardTitle className="text-base font-medium">organized goals</CardTitle>
                <p className="mt-1 text-xs text-muted-foreground">Drag between priority and out of priority. The MCP never chooses this for you.</p>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => openLaunch({ mode: "organized_goal", title: "start an organized goal" })}
              >
                <Plus className="size-3.5" /> goal
              </Button>
            </div>
          </CardHeader>
          <CardContent className="grid gap-3 px-4 sm:grid-cols-2">
            <GoalColumn
              title="in priority"
              goals={priorityGoals}
              list="priority"
              draggedGoalId={draggedGoalId}
              busy={priorityBusy}
              onDragStart={setDraggedGoalId}
              onDrop={beforeId => void moveGoal("priority", beforeId)}
              onOpen={id => setDetailTarget({ type: "organized_goal", id })}
              onEdit={goal =>
                openLaunch({
                  mode: "organized_goal",
                  title: `continue ${goal.title}`,
                  primaryEntityType: "organized_goal",
                  primaryEntityId: goal.id,
                  userSeedMd: goal.title,
                })
              }
            />
            <GoalColumn
              title="out of priority"
              goals={outOfPriorityGoals}
              list="out"
              draggedGoalId={draggedGoalId}
              busy={priorityBusy}
              onDragStart={setDraggedGoalId}
              onDrop={beforeId => void moveGoal("out", beforeId)}
              onOpen={id => setDetailTarget({ type: "organized_goal", id })}
              onEdit={goal =>
                openLaunch({
                  mode: "organized_goal",
                  title: `continue ${goal.title}`,
                  primaryEntityType: "organized_goal",
                  primaryEntityId: goal.id,
                  userSeedMd: goal.title,
                })
              }
            />
            {sunsetGoals.length > 0 && (
              <section className="rounded-lg border border-dashed p-2 sm:col-span-2">
                <p className="mb-1 px-1 text-xs font-medium uppercase text-muted-foreground">sunset goals</p>
                <div className="flex flex-wrap gap-1.5">
                  {sunsetGoals.map(goal => (
                    <button
                      key={goal.id}
                      className="rounded-full border px-2.5 py-1 text-left text-xs text-muted-foreground hover:bg-muted"
                      onClick={() => setDetailTarget({ type: "organized_goal", id: goal.id })}
                    >
                      {goal.title}
                    </button>
                  ))}
                </div>
              </section>
            )}
          </CardContent>
        </Card>

        <RegistryCard
          title="organized habits"
          description="The habits you chose to organize—not a second copy of the raw habit list."
          rows={feed.habits}
          mode="organized_habit"
          onCreate={() => openLaunch({ mode: "organized_habit", title: "start an organized habit" })}
          onOpen={id => setDetailTarget({ type: "organized_habit", id })}
          onEdit={row =>
            openLaunch({
              mode: "organized_habit",
              title: `continue ${row.title}`,
              primaryEntityType: "organized_habit",
              primaryEntityId: row.id,
              userSeedMd: row.title,
            })
          }
        />

        <RegistryCard
          title="organized environment"
          description="The conditions you deliberately want to reason about."
          rows={feed.environment}
          mode="organized_environment"
          onCreate={() => openLaunch({ mode: "organized_environment", title: "start an organized environment item" })}
          onOpen={id => setDetailTarget({ type: "organized_environment", id })}
          onEdit={row =>
            openLaunch({
              mode: "organized_environment",
              title: `continue ${row.title}`,
              primaryEntityType: "organized_environment",
              primaryEntityId: row.id,
              userSeedMd: row.title,
            })
          }
        />

        <GroupsCard
          groups={feed.groups}
          onChanged={changed}
          onCreate={() => openLaunch({ mode: "experiment_group", title: "start a change group" })}
          onOpen={id => setDetailTarget({ type: "experiment_group", id })}
          onEdit={group =>
            openLaunch({
              mode: "experiment_group",
              title: `continue ${group.title}`,
              primaryEntityType: "experiment_group",
              primaryEntityId: group.id,
              userSeedMd: group.title,
              selectedOrganizedGoalIds: group.goals.map(goal => goal.id),
            })
          }
          onCraftActionable={group =>
            openLaunch({
              mode: "actionable_experiment",
              title: `craft a weekly actionable for ${group.title}`,
              experimentGroupId: group.id,
            })
          }
        />

        <ActionablesCard
          rows={feed.actionables}
          onOpen={id => setDetailTarget({ type: "actionable_experiment", id })}
          onChanged={changed}
        />
      </div>

      {!loading && !error && feed.goals.length + feed.habits.length + feed.environment.length + feed.groups.length + feed.actionables.length === 0 && (
        <p className="rounded-lg border border-dashed px-3 py-8 text-center text-sm text-muted-foreground">
          Nothing organized yet. Start with a direction you name, then use an MCP conversation to make its context reviewable.
        </p>
      )}

      <p className="text-xs text-muted-foreground">
        Raw candidates, projects, and experiences remain available as linked context inside these records; they are not silently converted into organized items.
      </p>

      {launch && (
        <CollaborationDialog
          key={launch.key}
          launch={launch}
          availableGoals={activeGoals}
          onClose={() => setLaunch(null)}
          onChanged={changed}
          onTrackedInvite={trackInvite}
        />
      )}
      {detailTarget && (
        <OrganizedDetailHost
          target={detailTarget}
          onClose={() => setDetailTarget(null)}
          onOpenConversation={conversationId => setSourceConversationId(conversationId)}
          onOpenRawSource={source => {
            setDetailTarget(null);
            setRawDetailTarget(source);
          }}
        />
      )}
      {rawDetailTarget && (
        <RawSourceDetailHost
          target={rawDetailTarget}
          onClose={() => setRawDetailTarget(null)}
          onOpenConversation={conversationId => setSourceConversationId(conversationId)}
        />
      )}
      {sourceConversationId && (
        <SourceConversationDialog
          conversationId={sourceConversationId}
          onClose={() => setSourceConversationId(null)}
        />
      )}
    </div>
  );
}

function GoalColumn({
  title,
  goals,
  list,
  draggedGoalId,
  busy,
  onDragStart,
  onDrop,
  onOpen,
  onEdit,
}: {
  title: string;
  goals: OrganizedGoalRow[];
  list: GoalList;
  draggedGoalId: string | null;
  busy: boolean;
  onDragStart: (id: string) => void;
  onDrop: (beforeId?: string) => void;
  onOpen: (id: string) => void;
  onEdit: (goal: OrganizedGoalRow) => void;
}) {
  return (
    <section
      className="flex min-h-28 flex-col gap-1.5 rounded-lg border border-dashed p-2"
      onDragOver={event => event.preventDefault()}
      onDrop={event => {
        event.preventDefault();
        onDrop();
      }}
    >
      <p className="px-1 text-xs font-medium uppercase text-muted-foreground">{title}</p>
      {goals.map(goal => (
        <div
          key={goal.id}
          draggable={!busy}
          onDragStart={() => onDragStart(goal.id)}
          onDragOver={event => event.preventDefault()}
          onDrop={event => {
            event.preventDefault();
            event.stopPropagation();
            onDrop(goal.id);
          }}
          className={cn(
            "flex items-center gap-1 rounded-md border bg-background p-1.5",
            draggedGoalId === goal.id && "opacity-50",
          )}
        >
          <GripVertical className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
          <button className="min-w-0 flex-1 text-left text-sm" onClick={() => onOpen(goal.id)}>
            <span className="block truncate">{goal.title}</span>
            {goal.identityClause && <span className="block truncate text-xs text-muted-foreground">{goal.identityClause}</span>}
          </button>
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            onClick={() => onEdit(goal)}
            title={`continue ${goal.title} in MCP`}
          >
            <Pencil className="size-3.5" />
          </Button>
        </div>
      ))}
      {goals.length === 0 && <p className="px-1 py-3 text-xs text-muted-foreground">drop a goal here</p>}
      {list === "priority" && goals.length > 0 && <p className="px-1 text-[11px] text-muted-foreground">Ordered by your current focus.</p>}
    </section>
  );
}

function RegistryCard({
  title,
  description,
  rows,
  mode,
  onCreate,
  onOpen,
  onEdit,
}: {
  title: string;
  description: string;
  rows: OrganizedRegistryRow[];
  mode: CollaborationMode;
  onCreate: () => void;
  onOpen: (id: string) => void;
  onEdit: (row: OrganizedRegistryRow) => void;
}) {
  const active = rows.filter(row => row.status === "active");
  const sunset = rows.filter(row => row.status === "sunset");
  return (
    <Card className="py-4">
      <CardHeader className="px-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <CardTitle className="text-base font-medium">{title}</CardTitle>
            <p className="mt-1 text-xs text-muted-foreground">{description}</p>
          </div>
          <Button variant="outline" size="sm" onClick={onCreate}>
            <Plus className="size-3.5" /> add
          </Button>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-1.5 px-4">
        {active.map(row => (
          <div key={row.id} className="flex items-center gap-2 rounded-lg border px-2 py-1.5">
            <button className="min-w-0 flex-1 text-left" onClick={() => onOpen(row.id)}>
              <span className="block truncate text-sm">{row.title}</span>
              {(row.synthesisMd ?? row.note) && <span className="block truncate text-xs text-muted-foreground">{row.synthesisMd ?? row.note}</span>}
            </button>
            {(row.sourceCount ?? row.sources?.length) !== undefined && (
              <span className="text-xs text-muted-foreground">
                {row.sourceCount ?? row.sources?.length} source{(row.sourceCount ?? row.sources?.length) === 1 ? "" : "s"}
              </span>
            )}
            <Button variant="ghost" size="icon" className="size-7" onClick={() => onEdit(row)} title={`continue ${row.title} in MCP`}>
              <Pencil className="size-3.5" />
            </Button>
          </div>
        ))}
        {active.length === 0 && (
          <p className="rounded-lg border border-dashed px-3 py-4 text-center text-xs text-muted-foreground">
            {mode === "organized_habit" ? "Add only a habit you personally want to organize." : "Add an environment item when you want its context to be explicit."}
          </p>
        )}
        {sunset.length > 0 && (
          <section className="mt-1 flex flex-col gap-1 border-t pt-2">
            <p className="text-xs font-medium uppercase text-muted-foreground">sunset</p>
            {sunset.map(row => (
              <button
                key={row.id}
                className="flex items-center justify-between gap-2 rounded-md px-1.5 py-1 text-left text-xs text-muted-foreground hover:bg-muted"
                onClick={() => onOpen(row.id)}
              >
                <span className="truncate">{row.title}</span>
                <span>inspect</span>
              </button>
            ))}
          </section>
        )}
      </CardContent>
    </Card>
  );
}

function GroupsCard({
  groups,
  onChanged,
  onCreate,
  onOpen,
  onEdit,
  onCraftActionable,
}: {
  groups: ExperimentGroupRow[];
  onChanged: () => void;
  onCreate: () => void;
  onOpen: (id: string) => void;
  onEdit: (group: ExperimentGroupRow) => void;
  onCraftActionable: (group: ExperimentGroupRow) => void;
}) {
  const active = groups.filter(group => group.status === "active");
  const closed = groups.filter(group => group.status !== "active");
  return (
    <Card className="py-4 lg:col-span-2">
      <CardHeader className="px-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <CardTitle className="text-base font-medium">change groups</CardTitle>
            <p className="mt-1 text-xs text-muted-foreground">Long-lived change stories. They end only when you explicitly mark them done or sunset.</p>
          </div>
          <Button variant="outline" size="sm" onClick={onCreate}>
            <Plus className="size-3.5" /> group
          </Button>
        </div>
      </CardHeader>
      <CardContent className="grid gap-2 px-4 md:grid-cols-2">
        {active.map(group => (
          <GroupRow key={group.id} group={group} onChanged={onChanged} onOpen={onOpen} onEdit={onEdit} onCraftActionable={onCraftActionable} />
        ))}
        {active.length === 0 && (
          <p className="rounded-lg border border-dashed px-3 py-6 text-center text-sm text-muted-foreground md:col-span-2">
            No active change groups. Start from a theme you name and the organized goals you explicitly choose it to serve.
          </p>
        )}
        {closed.length > 0 && <p className="text-xs text-muted-foreground md:col-span-2">{closed.length} done or sunset group{closed.length === 1 ? "" : "s"}</p>}
        {closed.map(group => (
          <ClosedGroupRow key={group.id} group={group} onOpen={onOpen} />
        ))}
      </CardContent>
    </Card>
  );
}

function ClosedGroupRow({ group, onOpen }: { group: ExperimentGroupRow; onOpen: (id: string) => void }) {
  return (
    <button
      className="flex min-w-0 flex-col gap-1 rounded-lg border border-dashed p-3 text-left text-muted-foreground hover:bg-muted/40"
      onClick={() => onOpen(group.id)}
    >
      <span className="flex items-center justify-between gap-2">
        <span className="truncate text-sm font-medium">{group.title}</span>
        <Badge variant="outline">{group.status}</Badge>
      </span>
      {group.closingReviewMd && <span className="line-clamp-2 text-xs">{group.closingReviewMd}</span>}
      <span className="text-xs">{group.targets.filter(target => target.status === "done").length}/{group.targets.length} targets complete · inspect history</span>
    </button>
  );
}

function GroupRow({
  group,
  onChanged,
  onOpen,
  onEdit,
  onCraftActionable,
}: {
  group: ExperimentGroupRow;
  onChanged: () => void;
  onOpen: (id: string) => void;
  onEdit: (group: ExperimentGroupRow) => void;
  onCraftActionable: (group: ExperimentGroupRow) => void;
}) {
  const doneTargets = group.targets.filter(target => target.status === "done").length;
  const [closing, setClosing] = useState<"done" | "sunset" | null>(null);
  const [closingReview, setClosingReview] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const toggleTarget = async (target: ExperimentGroupRow["targets"][number]) => {
    setBusy(`target:${target.id}`);
    setError(null);
    try {
      await api.markExperimentGroupTarget(group.id, target.id, target.status !== "done");
      onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  const close = async () => {
    if (!closing) return;
    setBusy("close");
    setError(null);
    try {
      await api.closeExperimentGroup(group.id, closing, closingReview.trim() || undefined);
      setClosing(null);
      setClosingReview("");
      onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex flex-col gap-2 rounded-lg border p-3">
      <button className="min-w-0 text-left" onClick={() => onOpen(group.id)}>
        <div className="flex items-center justify-between gap-2">
          <span className="truncate text-sm font-medium">{group.title}</span>
          <Badge variant="outline">active</Badge>
        </div>
        {group.motivationMd && <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{group.motivationMd}</p>}
      </button>
      {group.goals.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {group.goals.map(goal => (
            <Badge key={goal.id} variant="secondary">{goal.title}</Badge>
          ))}
        </div>
      )}
      <p className="text-xs text-muted-foreground">
        {doneTargets}/{group.targets.length} targets complete{group.projectCount ? ` · ${group.projectCount} project${group.projectCount === 1 ? "" : "s"}` : ""}
      </p>
      {group.targets.length > 0 && (
        <ul className="flex flex-col gap-1">
          {group.targets.map(target => {
            const done = target.status === "done";
            return (
              <li key={target.id} className="flex items-center gap-2 text-xs">
                <button
                  className={cn("flex size-4 shrink-0 items-center justify-center rounded border", done && "bg-primary text-primary-foreground")}
                  title={done ? "mark target incomplete" : "mark target complete"}
                  disabled={busy === `target:${target.id}`}
                  onClick={() => void toggleTarget(target)}
                >
                  {done && <Check className="size-3" />}
                </button>
                <span className={cn("min-w-0 truncate", done && "text-muted-foreground line-through")}>{target.title}</span>
              </li>
            );
          })}
        </ul>
      )}
      <div className="flex flex-wrap gap-1.5">
        <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => onEdit(group)}>
          <Pencil className="size-3" /> continue
        </Button>
        <Button size="sm" className="h-7 px-2 text-xs" onClick={() => onCraftActionable(group)}>
          <CalendarDays className="size-3" /> craft week
        </Button>
        {!closing && (
          <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => setClosing("done")}>
            close group
          </Button>
        )}
      </div>
      {closing && (
        <div className="space-y-2 rounded-md border bg-muted/30 p-2">
          <p className="text-xs font-medium">close as {closing}</p>
          <Textarea
            value={closingReview}
            onChange={event => setClosingReview(event.target.value)}
            placeholder="What changed or why you are sunsetting this? (optional)"
            className="min-h-16 text-xs"
          />
          <div className="flex gap-1.5">
            <Button size="sm" className="h-7 px-2 text-xs" disabled={busy === "close"} onClick={() => void close()}>
              {busy === "close" ? "closing…" : `mark ${closing}`}
            </Button>
            <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => setClosing(closing === "done" ? "sunset" : "done")}>
              use {closing === "done" ? "sunset" : "done"}
            </Button>
            <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => setClosing(null)}>
              cancel
            </Button>
          </div>
        </div>
      )}
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}

function ActionablesCard({
  rows,
  onOpen,
  onChanged,
}: {
  rows: ActionableExperimentRow[];
  onOpen: (id: string) => void;
  onChanged: () => void;
}) {
  const current = rows.filter(row => row.status === "queued" || row.status === "scheduling" || row.status === "running");
  const recent = rows.filter(row => !current.includes(row)).slice(0, 5);
  return (
    <Card className="py-4 lg:col-span-2">
      <CardHeader className="px-4">
        <div className="flex items-center gap-2">
          <ListChecks className="size-4" />
          <div>
            <CardTitle className="text-base font-medium">current and recent actionables</CardTitle>
            <p className="mt-1 text-xs text-muted-foreground">Only a reviewed weekly actionable can become runnable. Calendar work is still separately confirmed.</p>
          </div>
        </div>
      </CardHeader>
      <CardContent className="grid gap-2 px-4 md:grid-cols-2">
        {[...current, ...recent].map(row => (
          <ActionableRow key={row.id} row={row} onOpen={onOpen} onChanged={onChanged} />
        ))}
        {rows.length === 0 && (
          <p className="rounded-lg border border-dashed px-3 py-6 text-center text-sm text-muted-foreground md:col-span-2">
            Start a weekly actionable from an active change group when you are ready. Nothing will be drafted or queued automatically.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function ActionableRow({
  row,
  onOpen,
  onChanged,
}: {
  row: ActionableExperimentRow;
  onOpen: (id: string) => void;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ending, setEnding] = useState<"succeeded" | "failed" | null>(null);
  const [review, setReview] = useState("");
  const tasks = row.tasks ?? [];

  const confirmSchedule = async () => {
    setBusy("schedule");
    setError(null);
    try {
      const result = await api.confirmActionableSchedule(row.id);
      if (!result.ok) throw new Error(result.error ?? "could not confirm the schedule");
      onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  const archive = async () => {
    setBusy("archive");
    setError(null);
    try {
      await api.archiveExperiment(row.id);
      onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  const toggleTask = async (taskId: string, currentStatus: "pending" | "scheduled" | "done" | "skipped", scheduleMode?: "calendar" | "none") => {
    setBusy(`task:${taskId}`);
    setError(null);
    try {
      await api.patchTask(taskId, currentStatus === "done" ? (scheduleMode === "calendar" ? "scheduled" : "pending") : "done");
      onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  const end = async (verdict: "succeeded" | "failed") => {
    setBusy("end");
    setError(null);
    try {
      await api.endExperiment(row.id, verdict, review.trim() || undefined);
      setEnding(null);
      setReview("");
      onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex flex-col gap-2 rounded-lg border p-3">
      <button className="min-w-0 text-left" onClick={() => onOpen(row.id)}>
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">{row.title}</span>
          <Badge variant="outline">{row.status}</Badge>
        </div>
        <p className="mt-1 truncate text-xs text-muted-foreground">
          {row.groupTitle ?? "change group"}{row.weekOf ? ` · week of ${row.weekOf}` : ""}
          {row.taskSummary ? ` · ${row.taskSummary.done}/${row.taskSummary.total} tasks` : ""}
        </p>
      </button>

      {row.status === "queued" && (
        <div className="flex flex-wrap gap-1.5">
          <Button size="sm" className="w-fit" disabled={busy !== null} onClick={() => void confirmSchedule()}>
            <CalendarCheck className="size-3.5" /> {busy === "schedule" ? "confirming…" : "confirm schedule & start"}
          </Button>
          <Button size="sm" variant="ghost" className="w-fit" disabled={busy !== null} onClick={() => void archive()}>
            {busy === "archive" ? "discarding…" : "discard this week"}
          </Button>
        </div>
      )}

      {row.status === "running" && tasks.length > 0 && (
        <ul className="flex flex-col gap-1">
          {tasks.map(task => {
            const done = task.status === "done";
            return (
              <li key={task.id} className="flex items-center gap-2 text-xs">
                <button
                  className={cn("flex size-4 shrink-0 items-center justify-center rounded border", done && "bg-primary text-primary-foreground")}
                  disabled={busy === `task:${task.id}`}
                  onClick={() => void toggleTask(task.id, task.status, task.scheduleMode)}
                  title={done ? "mark task unfinished" : "mark task complete"}
                >
                  {done && <Check className="size-3" />}
                </button>
                <span className={cn("min-w-0 flex-1", done && "text-muted-foreground line-through")}>{task.title}</span>
                {task.scheduleMode === "calendar" && task.scheduledFor && <span className="text-muted-foreground">calendar</span>}
              </li>
            );
          })}
        </ul>
      )}

      {row.status === "running" && (
        ending ? (
          <div className="space-y-2 rounded-md border bg-muted/30 p-2">
            <Textarea
              value={review}
              onChange={event => setReview(event.target.value)}
              placeholder={ending === "succeeded" ? "What changed? (optional review note)" : "What got in the way? (optional review note)"}
              className="min-h-16 text-xs"
            />
            <div className="flex gap-1.5">
              <Button size="sm" className="h-7 px-2 text-xs" disabled={busy === "end"} onClick={() => void end(ending)}>
                {busy === "end" ? "saving…" : ending === "succeeded" ? "it took" : "log it, move on"}
              </Button>
              <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => setEnding(null)}>cancel</Button>
            </div>
          </div>
        ) : (
          <div className="flex gap-1.5">
            <Button size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={() => setEnding("succeeded")}>
              <Check className="size-3" /> succeeded
            </Button>
            <Button size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={() => setEnding("failed")}>
              <X className="size-3" /> didn’t take
            </Button>
          </div>
        )
      )}
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}

function OrganizedDetailHost({
  target,
  onClose,
  onOpenConversation,
  onOpenRawSource,
}: {
  target: DetailTarget;
  onClose: () => void;
  onOpenConversation: (conversationId: string) => void;
  onOpenRawSource: (source: RawSourceTarget) => void;
}) {
  const { data: detail } = useApiData(() => api.organizedDetail(target.type, target.id), [target.type, target.id]);
  const { data: actionableDetail } = useApiData(
    () => (target.type === "actionable_experiment" ? api.experiment(target.id) : Promise.resolve(null)),
    [target.type, target.id],
  );
  if (!detail) return null;
  return (
    <OrganizedDetail
      detail={detail}
      actionableDetail={actionableDetail}
      onClose={onClose}
      onOpenConversation={onOpenConversation}
      onOpenRawSource={onOpenRawSource}
    />
  );
}

function OrganizedDetail({
  detail,
  actionableDetail,
  onClose,
  onOpenConversation,
  onOpenRawSource,
}: {
  detail: OrganizedEntityDetail;
  actionableDetail: Awaited<ReturnType<typeof api.experiment>> | null | undefined;
  onClose: () => void;
  onOpenConversation: (conversationId: string) => void;
  onOpenRawSource: (source: RawSourceTarget) => void;
}) {
  const entity = detail.entity;
  const actionableEntity = detail.entityType === "actionable_experiment" ? (entity as ActionableExperimentRow) : null;
  const groupEntity = detail.entityType === "experiment_group" ? (entity as ExperimentGroupRow) : null;
  const description = "synthesisMd" in entity
    ? entity.synthesisMd
    : "motivationMd" in entity
      ? entity.motivationMd
      : entity.hypothesisMd;
  const groupContext = groupEntity
    ? [
        groupEntity.targets.length
          ? `## Intended targets\n${groupEntity.targets.map(target => `- [${target.status === "done" ? "x" : " "}] ${target.title}${target.detailMd ? ` — ${target.detailMd}` : ""}`).join("\n")}`
          : null,
        groupEntity.projects?.length
          ? `## Related projects\n${groupEntity.projects.map(project => `- ${project.title}${project.note ? ` — ${project.note}` : ""}`).join("\n")}`
          : null,
        groupEntity.contexts?.length
          ? `## Group context\n${groupEntity.contexts.map(context => context.textMd).join("\n\n")}`
          : null,
      ]
        .filter((section): section is string => Boolean(section))
        .join("\n\n")
    : null;
  return (
    <DetailModal
      open
      onClose={onClose}
      kindLabel={detail.entityType.replaceAll("_", " ")}
      title={entity.title}
      detail={[description, groupContext].filter((section): section is string => Boolean(section)).join("\n\n") || null}
      relations={{
        sources: detail.sources.map(source => ({
          id: `${source.entityType}:${source.entityId}`,
          title: source.title ?? `${source.entityType.replaceAll("_", " ")} ${source.entityId.slice(0, 8)}`,
          status: source.entityType.replaceAll("_", " "),
          onOpen: () => onOpenRawSource({
            entityType: source.entityType as RawSourceTarget["entityType"],
            entityId: source.entityId,
          }),
        })),
      }}
      extractions={detail.extractions}
      onOpenConversation={onOpenConversation}
      schedule={
        detail.entityType === "actionable_experiment"
          ? {
              tasks: actionableDetail?.tasks ?? actionableEntity?.tasks ?? [],
              plannedDurationDays: actionableDetail?.plannedDurationDays ?? actionableEntity?.plannedDurationDays,
              startedAt: actionableDetail?.startedAt ?? actionableEntity?.startedAt,
              bandwidth: actionableDetail?.bandwidth ?? null,
            }
          : undefined
      }
      calendar={detail.entityType === "actionable_experiment" ? actionableDetail?.calendarEvents : undefined}
    />
  );
}

// Organized records are deliberately only a curated layer over the raw
// proposal-derived system. Opening a linked source moves into the existing
// raw detail shape, where its extraction citations lead to the source rants.
// This avoids a second, lossy provenance viewer in the Organized Feed.
function RawSourceDetailHost({
  target,
  onClose,
  onOpenConversation,
}: {
  target: RawSourceTarget;
  onClose: () => void;
  onOpenConversation: (conversationId: string) => void;
}) {
  const { data } = useApiData<
    | Awaited<ReturnType<typeof api.goal>>
    | Awaited<ReturnType<typeof api.habit>>
    | Awaited<ReturnType<typeof api.environmentItem>>
    | Awaited<ReturnType<typeof api.experience>>
    | Awaited<ReturnType<typeof api.experiment>>
    | Awaited<ReturnType<typeof api.project>>
  >(() => {
    switch (target.entityType) {
      case "goal":
        return api.goal(target.entityId);
      case "habit":
        return api.habit(target.entityId);
      case "environment_item":
        return api.environmentItem(target.entityId);
      case "experience":
        return api.experience(target.entityId);
      case "experiment":
        return api.experiment(target.entityId);
      case "project":
        return api.project(target.entityId);
    }
  }, [target.entityType, target.entityId]);
  if (!data) return null;

  if (target.entityType === "goal") {
    const goal = data as Awaited<ReturnType<typeof api.goal>>;
    return (
      <DetailModal
        open
        onClose={onClose}
        kindLabel={`raw goal · ${goal.status}`}
        title={goal.title}
        detail={[goal.identityClause, goal.synthesisMd].filter(Boolean).join("\n\n") || null}
        relations={{ habits: goal.idealHabits, environment: goal.idealEnvironment, experiments: goal.experiments }}
        evidence={goal.evidence}
        calendar={goal.schedule}
        pendingProposals={goal.pendingProposals}
        extractions={goal.extractions}
        onOpenConversation={onOpenConversation}
      />
    );
  }
  if (target.entityType === "habit") {
    const habit = data as Awaited<ReturnType<typeof api.habit>>;
    return (
      <DetailModal
        open
        onClose={onClose}
        kindLabel={`raw habit · ${habit.status}${habit.valence === "bad" ? " · bad" : ""}`}
        title={habit.title}
        detail={habit.note}
        relations={{ goals: habit.goals, experiments: habit.bornInExperiment ? [habit.bornInExperiment] : undefined }}
        calendar={habit.calendarEvents}
        extractions={habit.extractions}
        onOpenConversation={onOpenConversation}
      />
    );
  }
  if (target.entityType === "environment_item") {
    const environment = data as Awaited<ReturnType<typeof api.environmentItem>>;
    return (
      <DetailModal
        open
        onClose={onClose}
        kindLabel={`raw environment · ${environment.subKind} · ${environment.status}`}
        title={environment.title}
        detail={environment.note}
        relations={{ goals: environment.goals }}
        calendar={environment.calendarEvents}
        extractions={environment.extractions}
        onOpenConversation={onOpenConversation}
      />
    );
  }
  if (target.entityType === "experience") {
    const experience = data as Awaited<ReturnType<typeof api.experience>>;
    return (
      <DetailModal
        open
        onClose={onClose}
        kindLabel={`raw experience · ${experience.state}`}
        title={experience.title}
        detail={experience.note}
        relations={{ experiments: experience.fromExperiment ? [experience.fromExperiment] : undefined }}
        calendar={experience.calendarEvents}
        extractions={experience.extractions}
        onOpenConversation={onOpenConversation}
      />
    );
  }
  if (target.entityType === "project") {
    const project = data as Awaited<ReturnType<typeof api.project>>;
    return (
      <DetailModal
        open
        onClose={onClose}
        kindLabel="raw project"
        title={project.title}
        detail={project.note}
        relations={{ sources: project.sources }}
        extractions={project.extractions}
        onOpenConversation={onOpenConversation}
      />
    );
  }
  const experiment = data as Awaited<ReturnType<typeof api.experiment>>;
  return (
    <DetailModal
      open
      onClose={onClose}
      kindLabel={`raw experiment candidate · ${experiment.status}`}
      title={experiment.title}
      detail={experiment.hypothesisMd}
      checklist={experiment.proposedChanges}
      relations={{
        goals: experiment.goals,
        habits: experiment.habitsBorn,
        experiences: experiment.experiences.map(experience => ({ ...experience, status: experience.state })),
      }}
      calendar={experiment.calendarEvents}
      extractions={experiment.extractions}
      onOpenConversation={onOpenConversation}
      schedule={{
        tasks: experiment.tasks,
        plannedDurationDays: experiment.plannedDurationDays,
        startedAt: experiment.startedAt,
        bandwidth: experiment.bandwidth,
      }}
    />
  );
}

// The final provenance hop deliberately has no pipeline or moderation
// controls. From an organized record the user can inspect the raw record,
// its cited extraction, and then read the exact source conversation without
// accidentally treating that source view as an editing surface.
function SourceConversationDialog({
  conversationId,
  onClose,
}: {
  conversationId: string;
  onClose: () => void;
}) {
  const { data: conversation, error, loading } = useApiData(
    () => api.conversation(conversationId),
    [conversationId],
  );

  return (
    <Dialog open onOpenChange={open => !open && onClose()}>
      <DialogContent className="flex max-h-[85vh] max-w-3xl flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle className="pr-8 text-left text-base">
            {conversation?.title ?? "source conversation"}
          </DialogTitle>
          <DialogDescription className="text-left">
            Read-only source transcript for this citation.
          </DialogDescription>
        </DialogHeader>

        {loading && <p className="py-8 text-center text-sm text-muted-foreground">loading source conversation…</p>}
        {error && <p className="rounded-lg border border-destructive/50 bg-destructive/5 px-3 py-2 text-sm text-destructive">Could not load this source conversation: {error}</p>}
        {conversation && (
          <>
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
              <span>source: {conversation.source}</span>
              <span>created: {(conversation.sourceCreatedAt ?? conversation.createdAt).slice(0, 16).replace("T", " ")}</span>
              <span>messages: {conversation.messages?.length ?? 0}</span>
            </div>
            <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto rounded-lg border p-3">
              {(conversation.messages ?? []).map((message, index) => (
                <div
                  key={index}
                  className={cn(
                    "max-w-[90%] whitespace-pre-wrap rounded-xl px-3 py-2 text-sm",
                    message.role === "user" ? "self-end bg-primary text-primary-foreground" : "self-start bg-muted",
                  )}
                >
                  {message.content}
                </div>
              ))}
              {!conversation.messages?.length && (
                <p className="py-8 text-center text-sm text-muted-foreground">This source conversation has no readable messages.</p>
              )}
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
