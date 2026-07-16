import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, Clipboard, Loader2, RefreshCw, Send, X } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  api,
  type CollaborationInviteRow,
  type CollaborationMode,
  type CollaborationWorkspaceRow,
  type DraftChangeSetOperation,
  type DraftChangeSetRow,
  type OrganizedGoalRow,
  type OrganizedPrimaryEntityType,
} from "@/lib/api";
import { useApiData } from "@/lib/useApiData";
import { cn } from "@/lib/utils";

export interface CollaborationLaunch {
  /** A local key makes a new modal session remount instead of inheriting form state. */
  key: string;
  mode: CollaborationMode;
  title: string;
  primaryEntityType?: OrganizedPrimaryEntityType;
  primaryEntityId?: string;
  experimentGroupId?: string;
  userSeedMd?: string;
  selectedOrganizedGoalIds?: string[];
  /** Browser-held dashboard capability for a previously created invite. */
  dashboardCapability?: string;
  /** Reopens a dashboard-owned invite after its original modal was closed. */
  inviteId?: string;
  /** Opens a durable draft from the feed's ready-for-review list. */
  changeSetId?: string;
}

const MODE_COPY: Record<CollaborationMode, { heading: string; seedLabel: string; seedPlaceholder: string; helper: string }> = {
  organized_goal: {
    heading: "organized goal",
    seedLabel: "your one-line direction",
    seedPlaceholder: "e.g. have higher agency",
    helper: "You name the direction. The MCP conversation helps uncover wording, motivation, and the raw context that belongs with it.",
  },
  organized_habit: {
    heading: "organized habit",
    seedLabel: "the habit you want represented",
    seedPlaceholder: "e.g. protect my first hour from reactive scrolling",
    helper: "This is a curated description of a habit you choose to represent, not an agent-created diagnosis.",
  },
  organized_environment: {
    heading: "organized environment",
    seedLabel: "the environment change you want represented",
    seedPlaceholder: "e.g. make the guitar the easiest thing to pick up",
    helper: "Use the MCP conversation to connect the change to your goals and existing evidence. It cannot schedule or calendar-commit anything.",
  },
  experiment_group: {
    heading: "change group",
    seedLabel: "the one-line change theme",
    seedPlaceholder: "e.g. become someone who throws parties",
    helper: "A group holds the long-lived why and intended changes. It is not a weekly plan and never creates calendar or witness activity.",
  },
  actionable_experiment: {
    heading: "weekly actionable",
    seedLabel: "this week's intent",
    seedPlaceholder: "e.g. make one small, real attempt this week",
    helper: "The MCP conversation narrows this to a guilt-free one-week experiment. Scheduling remains a later, separate confirmation.",
  },
};

function modeLabel(mode: CollaborationMode) {
  return MODE_COPY[mode].heading;
}

function opTitle(operation: DraftChangeSetOperation, index: number) {
  return operation.type ? operation.type.replaceAll("_", " ") : `operation ${index + 1}`;
}

function shortDate(value: string | null) {
  return value ? new Date(value).toLocaleString() : null;
}

export function CollaborationDialog({
  launch,
  availableGoals,
  onClose,
  onChanged,
  onTrackedInvite,
}: {
  launch: CollaborationLaunch;
  availableGoals: OrganizedGoalRow[];
  onClose: () => void;
  onChanged: () => void;
  onTrackedInvite: (invite: { id: string; dashboardCapability: string }) => void;
}) {
  const copy = MODE_COPY[launch.mode];
  const [seed, setSeed] = useState(launch.userSeedMd ?? "");
  const [selectedGoalIds, setSelectedGoalIds] = useState<string[]>(launch.selectedOrganizedGoalIds ?? []);
  const [invite, setInvite] = useState<CollaborationInviteRow | null>(null);
  const [workspace, setWorkspace] = useState<CollaborationWorkspaceRow | null>(null);
  const [draft, setDraft] = useState<DraftChangeSetRow | null>(null);
  const [busy, setBusy] = useState<"create" | "apply" | "reject" | "return" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState("");
  const [copied, setCopied] = useState(false);
  // Separate from the invite row on purpose: an OTP is returned once, whereas
  // invite polling intentionally never echoes a credential back to the client.
  const [inviteCode, setInviteCode] = useState<string | null>(null);
  const [dashboardCapability, setDashboardCapability] = useState<string | null>(launch.dashboardCapability ?? null);
  const [applied, setApplied] = useState(false);
  const [rejected, setRejected] = useState(false);

  // A durable draft can be opened after its original invite dialog was closed.
  const { data: existingDraft, error: existingDraftError, refresh: refreshExistingDraft } = useApiData(
    () => (launch.changeSetId && dashboardCapability ? api.changeSet(launch.changeSetId, dashboardCapability) : Promise.resolve(null)),
    [launch.changeSetId, dashboardCapability],
  );
  const {
    data: existingInviteStatus,
    error: existingInviteError,
    refresh: refreshExistingInvite,
  } = useApiData(
    () => (launch.inviteId && dashboardCapability ? api.collaborationInvite(launch.inviteId, dashboardCapability) : Promise.resolve(null)),
    [launch.inviteId, dashboardCapability],
  );

  useEffect(() => {
    if (!existingDraft) return;
    setDraft(existingDraft);
  }, [existingDraft]);

  useEffect(() => {
    if (!existingInviteStatus) return;
    setInvite(existingInviteStatus.invite);
    setWorkspace(existingInviteStatus.workspace);
    if (existingInviteStatus.changeSet) setDraft(existingInviteStatus.changeSet);
  }, [existingInviteStatus]);

  const inspectInvite = useCallback(async () => {
    if (!invite || !dashboardCapability) return;
    setError(null);
    try {
      const status = await api.collaborationInvite(invite.id, dashboardCapability);
      setInvite(status.invite);
      setWorkspace(status.workspace);
      if (status.changeSet) setDraft(status.changeSet);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [invite, dashboardCapability]);

  // The dashboard is intentionally passive: it notices redemption/drafting,
  // but never generates or applies anything on its own.
  useEffect(() => {
    // Saving a draft is not the end of the collaboration. Keep observing while
    // it remains drafting so MCP submission, returned feedback, and a revised
    // draft naturally move this same modal into the next review state.
    if (!invite || !dashboardCapability || applied || rejected || (draft && draft.status !== "drafting")) return;
    let cancelled = false;
    const check = async () => {
      try {
        const status = await api.collaborationInvite(invite.id, dashboardCapability);
        if (cancelled) return;
        setInvite(status.invite);
        setWorkspace(status.workspace);
        if (status.changeSet) setDraft(status.changeSet);
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      }
    };
    void check();
    const interval = window.setInterval(() => void check(), 3_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [invite, dashboardCapability, draft, applied, rejected]);

  const activeGoals = useMemo(
    () => availableGoals.filter(goal => goal.status === "active").sort((a, b) => (a.priorityRank ?? Infinity) - (b.priorityRank ?? Infinity)),
    [availableGoals],
  );
  const needsGoalSelection = launch.mode === "experiment_group" && !launch.primaryEntityId;

  const createInvite = async () => {
    const userSeedMd = seed.trim();
    if (!userSeedMd) {
      setError("Start with your own one-line direction or intent.");
      return;
    }
    if (needsGoalSelection && selectedGoalIds.length === 0) {
      setError("Choose at least one organized goal this group should serve.");
      return;
    }

    setBusy("create");
    setError(null);
    try {
      const created = await api.createCollaborationInvite({
        mode: launch.mode,
        userSeedMd,
        primaryEntityType: launch.primaryEntityType ?? launch.mode,
        primaryEntityId: launch.primaryEntityId,
        experimentGroupId: launch.experimentGroupId,
        selectedOrganizedGoalIds: launch.mode === "experiment_group" ? selectedGoalIds : undefined,
      });
      setInvite(created.invite);
      setDashboardCapability(created.dashboardCapability);
      onTrackedInvite({ id: created.invite.id, dashboardCapability: created.dashboardCapability });
      // The code deliberately lives only in this local UI state. The server
      // stores a hash, so re-fetching the invite never reveals it again.
      setInviteCode(created.code);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  const copyCode = async () => {
    if (!inviteCode) return;
    try {
      await navigator.clipboard.writeText(inviteCode);
      setCopied(true);
    } catch {
      // Selection remains available in the readonly input when clipboard
      // permissions are unavailable (for example on a non-HTTPS dev origin).
      setCopied(false);
    }
  };

  const refreshDraft = async () => {
    setError(null);
    try {
      if (invite) await inspectInvite();
      if (draft && dashboardCapability) setDraft(await api.changeSet(draft.id, dashboardCapability));
      if (launch.changeSetId) await refreshExistingDraft();
      if (launch.inviteId) await refreshExistingInvite();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const apply = async () => {
    if (!draft || !dashboardCapability) return;
    setBusy("apply");
    setError(null);
    try {
      await api.applyChangeSet(draft.id, dashboardCapability);
      setApplied(true);
      onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  const reject = async (returnToDrafting: boolean) => {
    if (!draft || !dashboardCapability) return;
    setBusy(returnToDrafting ? "return" : "reject");
    setError(null);
    try {
      const result = await api.rejectChangeSet(draft.id, dashboardCapability, {
        feedback: feedback.trim() || undefined,
        returnToDrafting,
      });
      setDraft(result.changeSet);
      if (returnToDrafting) {
        setFeedback("");
      } else {
        setRejected(true);
        onChanged();
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  const toggleGoal = (id: string) => {
    setSelectedGoalIds(ids => (ids.includes(id) ? ids.filter(current => current !== id) : [...ids, id]));
  };

  return (
    <Dialog open onOpenChange={open => !open && onClose()}>
      <DialogContent className="flex max-h-[90vh] max-w-3xl flex-col overflow-hidden">
        <DialogHeader>
          <div className="flex items-center gap-2">
            <Badge variant="outline">MCP collaboration</Badge>
            <Badge variant="secondary">{modeLabel(launch.mode)}</Badge>
          </div>
          <DialogTitle className="pr-6 text-left">{launch.title}</DialogTitle>
          <DialogDescription className="text-left">{copy.helper}</DialogDescription>
        </DialogHeader>

        <div className="min-h-0 space-y-4 overflow-y-auto pr-1">
          {error && <p className="rounded-lg border border-destructive/50 bg-destructive/5 px-3 py-2 text-sm text-destructive">{error}</p>}
          {(existingDraftError || existingInviteError) && !draft && !invite && (
            <p className="rounded-lg border border-destructive/50 bg-destructive/5 px-3 py-2 text-sm text-destructive">
              {existingDraftError ?? existingInviteError}
            </p>
          )}

          {!invite && !draft && !launch.changeSetId && !applied && !rejected && (
            <section className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="collaboration-seed">{copy.seedLabel}</Label>
                <Textarea
                  id="collaboration-seed"
                  value={seed}
                  onChange={event => setSeed(event.target.value)}
                  placeholder={copy.seedPlaceholder}
                  className="min-h-24"
                  autoFocus
                />
              </div>

              {needsGoalSelection && (
                <fieldset className="space-y-2 rounded-lg border p-3">
                  <legend className="px-1 text-sm font-medium">organized goals this group serves</legend>
                  <p className="text-xs text-muted-foreground">
                    You choose these before the MCP conversation; it may help explain the relationship, but cannot choose them for you.
                  </p>
                  {activeGoals.length === 0 ? (
                    <p className="text-sm text-muted-foreground">Create an organized goal first, then start a change group from it.</p>
                  ) : (
                    <div className="grid gap-1.5 sm:grid-cols-2">
                      {activeGoals.map(goal => (
                        <Label key={goal.id} className="flex cursor-pointer items-center gap-2 rounded-md border px-2.5 py-2 text-sm font-normal">
                          <input
                            type="checkbox"
                            checked={selectedGoalIds.includes(goal.id)}
                            onChange={() => toggleGoal(goal.id)}
                            className="size-4 accent-primary"
                          />
                          <span className="min-w-0 truncate">{goal.title}</span>
                          {goal.priorityRank !== null && <span className="ml-auto text-xs text-muted-foreground">priority</span>}
                        </Label>
                      ))}
                    </div>
                  )}
                </fieldset>
              )}

              <p className="rounded-lg bg-muted px-3 py-2 text-xs text-muted-foreground">
                This creates only a short-lived connection request. Closing before an MCP redemption creates no organized item.
              </p>
            </section>
          )}

          {!invite && !draft && (launch.changeSetId || launch.inviteId) && !applied && !rejected && !existingDraftError && !existingInviteError && (
            <div className="flex items-center gap-2 rounded-lg border border-dashed px-3 py-6 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> loading the reviewable change set…
            </div>
          )}

          {invite && !draft && !applied && !rejected && (
            <InviteWaiting
              invite={invite}
              workspace={workspace}
              code={inviteCode}
              copied={copied}
              onCopy={() => void copyCode()}
              onCheck={() => void inspectInvite()}
            />
          )}

          {draft && !applied && !rejected && (
            <DraftReview
              draft={draft}
              feedback={feedback}
              onFeedbackChange={setFeedback}
              onRefresh={() => void refreshDraft()}
              onApply={() => void apply()}
              onReject={() => void reject(false)}
              onReturnToDrafting={() => void reject(true)}
              busy={busy}
            />
          )}

          {applied && (
            <section className="rounded-lg border border-emerald-300 bg-emerald-50 p-4 text-sm dark:border-emerald-900 dark:bg-emerald-950">
              <div className="mb-1 flex items-center gap-2 font-medium">
                <Check className="size-4" /> reviewed change set applied
              </div>
              <p className="text-muted-foreground">The complete reviewed set was committed. Nothing outside it was changed.</p>
            </section>
          )}

          {rejected && (
            <section className="rounded-lg border border-dashed p-4 text-sm">
              <div className="mb-1 flex items-center gap-2 font-medium">
                <X className="size-4" /> change set rejected
              </div>
              <p className="text-muted-foreground">No organized, raw, calendar, or witness state was written.</p>
            </section>
          )}
        </div>

        <DialogFooter>
          {(applied || rejected) ? (
            <Button onClick={onClose}>done</Button>
          ) : !invite && !draft && !launch.changeSetId && !launch.inviteId ? (
            <Button disabled={busy === "create"} onClick={() => void createInvite()}>
              {busy === "create" ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
              create connection code
            </Button>
          ) : (
            <Button variant="outline" onClick={onClose}>close for now</Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function InviteWaiting({
  invite,
  workspace,
  code,
  copied,
  onCopy,
  onCheck,
}: {
  invite: CollaborationInviteRow;
  workspace: CollaborationWorkspaceRow | null;
  code: string | null;
  copied: boolean;
  onCopy: () => void;
  onCheck: () => void;
}) {
  return (
    <section className="space-y-4">
      <div className="rounded-lg border bg-muted/40 p-4">
        <p className="mb-1 text-sm font-medium">connect this conversation</p>
        <p className="text-sm text-muted-foreground">
          In your ChatGPT/Claude conversation with the Dream Coach MCP, provide this one-time code and let the agent use the scoped workspace.
        </p>
        {code ? (
          <div className="mt-3 flex gap-2">
            <Input readOnly value={code} onFocus={event => event.currentTarget.select()} className="font-mono tracking-[0.2em]" />
            <Button variant="outline" size="icon" onClick={onCopy} title="copy code">
              {copied ? <Check className="size-4" /> : <Clipboard className="size-4" />}
            </Button>
          </div>
        ) : (
          <p className="mt-3 rounded-md border border-dashed px-3 py-2 text-sm text-muted-foreground">
            This draft was opened after redemption; the one-time code is intentionally not shown again.
          </p>
        )}
      </div>

      <div className="flex items-center justify-between gap-3 rounded-lg border p-3 text-sm">
        <div>
          <p className="font-medium">
            {workspace ? "MCP workspace connected" : "waiting for the MCP to redeem the code"}
          </p>
          <p className="text-xs text-muted-foreground">
            {workspace
              ? "When the agent submits a draft, this modal will switch to your review."
              : `The code expires ${shortDate(invite.expiresAt) ?? "soon"}.`}
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={onCheck}>
          <RefreshCw className="size-3.5" /> check
        </Button>
      </div>
    </section>
  );
}

function DraftReview({
  draft,
  feedback,
  onFeedbackChange,
  onRefresh,
  onApply,
  onReject,
  onReturnToDrafting,
  busy,
}: {
  draft: DraftChangeSetRow;
  feedback: string;
  onFeedbackChange: (value: string) => void;
  onRefresh: () => void;
  onApply: () => void;
  onReject: () => void;
  onReturnToDrafting: () => void;
  busy: "create" | "apply" | "reject" | "return" | null;
}) {
  const ready = draft.status === "ready_for_review";
  return (
    <section className="space-y-4">
      <div className={cn("rounded-lg border p-3", ready ? "border-amber-300 bg-amber-50 dark:border-amber-900 dark:bg-amber-950" : "bg-muted/40")}>
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="font-medium">{ready ? "your review is required" : `draft is ${draft.status.replaceAll("_", " ")}`}</p>
            <p className="text-xs text-muted-foreground">One atomic change set centered on a {modeLabel(draft.mode)}.</p>
          </div>
          <Button variant="ghost" size="sm" onClick={onRefresh}>
            <RefreshCw className="size-3.5" /> refresh
          </Button>
        </div>
      </div>

      <section className="space-y-2">
        <p className="text-xs font-medium uppercase text-muted-foreground">intent and reasoning</p>
        <p className="whitespace-pre-wrap rounded-lg border p-3 text-sm">{draft.summaryMd}</p>
      </section>

      <section className="space-y-2">
        <p className="text-xs font-medium uppercase text-muted-foreground">intended changes — applied together or not at all</p>
        <div className="space-y-2">
          {draft.operations.map((operation, index) => (
            <div key={`${operation.type}-${index}`} className="rounded-lg border p-3">
              <p className="mb-2 text-sm font-medium capitalize">{opTitle(operation, index)}</p>
              <pre className="overflow-x-auto whitespace-pre-wrap text-xs text-muted-foreground">
                {JSON.stringify(operation, null, 2)}
              </pre>
            </div>
          ))}
          {draft.operations.length === 0 && <p className="rounded-lg border border-dashed p-3 text-sm text-muted-foreground">No operations were supplied; this cannot be applied.</p>}
        </div>
      </section>

      {draft.sourceRefs.length > 0 && (
        <section className="space-y-2">
          <p className="text-xs font-medium uppercase text-muted-foreground">linked raw context</p>
          <div className="flex flex-wrap gap-1.5">
            {draft.sourceRefs.map(source => (
              <Badge key={`${source.entityType}-${source.entityId}`} variant="outline">
                {source.entityType.replaceAll("_", " ")}: {source.title ?? source.entityId.slice(0, 8)}
                {source.note ? ` — ${source.note}` : ""}
              </Badge>
            ))}
          </div>
        </section>
      )}

      {ready && (
        <section className="space-y-2 border-t pt-4">
          <Label htmlFor="change-set-feedback">feedback if you want the MCP conversation to revise it</Label>
          <Textarea
            id="change-set-feedback"
            value={feedback}
            onChange={event => onFeedbackChange(event.target.value)}
            placeholder="What should change? This is sent back to the same draft workspace; it does not write state."
            className="min-h-20"
          />
          <div className="flex flex-wrap gap-2">
            <Button disabled={busy !== null || draft.operations.length === 0} onClick={onApply}>
              {busy === "apply" && <Loader2 className="size-4 animate-spin" />}
              apply entire change set
            </Button>
            <Button variant="outline" disabled={busy !== null} onClick={onReturnToDrafting}>
              {busy === "return" && <Loader2 className="size-4 animate-spin" />}
              send back to MCP
            </Button>
            <Button variant="ghost" disabled={busy !== null} onClick={onReject}>
              {busy === "reject" && <Loader2 className="size-4 animate-spin" />}
              reject
            </Button>
          </div>
        </section>
      )}
    </section>
  );
}
