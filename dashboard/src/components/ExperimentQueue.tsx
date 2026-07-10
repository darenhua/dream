import { useState } from "react";
import { Archive, Check, ClipboardCopy, FlaskConical, Play, X } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { api, type CurrentExperiment, type ExperimentRow, type TaskRow } from "@/lib/api";
import { useApiData } from "@/lib/useApiData";
import { cn } from "@/lib/utils";
import { DetailModal } from "./DetailModal";

// The experiments queue on the main feed: the current (running) experiment is
// the highlighted member; the rest wait their turn. New candidates only ever
// arrive from rants via approved proposals.
export function ExperimentQueue({
  tick,
  onChanged,
  onOpenScheduleChat,
}: {
  tick: number;
  onChanged: () => void;
  onOpenScheduleChat: (sessionId: string) => void;
}) {
  const { data: current } = useApiData(() => api.currentExperiment(), [tick]);
  const { data: queue } = useApiData(() => api.experimentQueue(), [tick]);
  const [picking, setPicking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  // Same DetailModal as proposals — schedule objects render once they exist.
  const { data: openDetail } = useApiData(
    () => (openId ? api.experiment(openId) : Promise.resolve(null)),
    [openId, tick],
  );

  const rest = (queue ?? []).filter(e => e.id !== current?.id);

  const pick = async (id: string) => {
    setPicking(id);
    setError(null);
    try {
      const result = await api.pickExperiment(id);
      onOpenScheduleChat(result.sessionId);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPicking(null);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base font-medium">
          <FlaskConical className="size-4" /> experiments
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {current ? (
          current.isRunning ? (
            <RunningExperimentCard experiment={current} onChanged={onChanged} onOpen={() => setOpenId(current.id)} />
          ) : (
            <QueueRow
              experiment={current}
              highlighted
              picking={picking === current.id}
              onPick={() => pick(current.id)}
              onArchived={onChanged}
              onOpen={() => setOpenId(current.id)}
              onResume={
                current.status === "scheduling"
                  ? async () => {
                      const session = await api.chatSessionForExperiment(current.id).catch(() => null);
                      if (session) onOpenScheduleChat(session.id);
                    }
                  : undefined
              }
            />
          )
        ) : (
          <p className="rounded-lg border border-dashed px-3 py-4 text-center text-sm text-muted-foreground">
            no experiments yet — new candidates arrive from your rants. want one? copy the prompt
            below, rant in the Claude app, import.
          </p>
        )}

        {rest.length > 0 && (
          <div className="flex flex-col gap-2">
            <p className="text-xs font-medium uppercase text-muted-foreground">up next</p>
            {rest.map(e => (
              <QueueRow
                key={e.id}
                experiment={e}
                picking={picking === e.id}
                onPick={() => pick(e.id)}
                onArchived={onChanged}
                onOpen={() => setOpenId(e.id)}
              />
            ))}
          </div>
        )}

        {error && <p className="text-sm text-destructive">{error}</p>}
        <ExperimentPromptButton />
      </CardContent>

      {openId && openDetail && (
        <DetailModal
          open
          onClose={() => setOpenId(null)}
          kindLabel={openDetail.status === "running" ? "running experiment" : `experiment · ${openDetail.status}`}
          title={openDetail.title}
          detail={openDetail.hypothesisMd}
          checklist={openDetail.proposedChanges}
          relations={{
            goals: openDetail.goals,
            habits: openDetail.habitsBorn.map(h => ({ id: h.id, title: h.title, status: h.status })),
            experiences: openDetail.experiences.map(x => ({ id: x.id, title: x.title, status: x.state })),
          }}
          calendar={openDetail.calendarEvents}
          extractions={openDetail.extractions}
          schedule={
            openDetail.status === "running" || openDetail.tasks.length
              ? {
                  tasks: openDetail.tasks,
                  plannedDurationDays: openDetail.plannedDurationDays,
                  startedAt: openDetail.startedAt,
                  bandwidth: openDetail.bandwidth,
                }
              : undefined
          }
        />
      )}
    </Card>
  );
}

function QueueRow({
  experiment,
  highlighted = false,
  picking,
  onPick,
  onArchived,
  onResume,
  onOpen,
}: {
  experiment: ExperimentRow | CurrentExperiment;
  highlighted?: boolean;
  picking: boolean;
  onPick: () => void;
  onArchived: () => void;
  onResume?: () => void;
  onOpen: () => void;
}) {
  const scheduling = experiment.status === "scheduling";
  return (
    <div
      className={cn(
        "flex flex-col gap-1 rounded-lg border px-3 py-2",
        highlighted && "border-orange-300 bg-orange-50/50 dark:border-orange-800 dark:bg-orange-950/50",
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <button className="min-w-0 text-left text-sm font-medium hover:underline" onClick={onOpen}>
          {experiment.title}
        </button>
        <div className="flex items-center gap-1">
          {scheduling ? (
            <Button size="sm" variant="secondary" onClick={onResume} disabled={!onResume}>
              scheduling…
            </Button>
          ) : (
            <>
              <Button size="sm" variant="outline" disabled={picking} onClick={onPick}>
                <Play className="size-3" /> {picking ? "opening…" : "pick"}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                title="archive (it stopped speaking to you — that's fine)"
                onClick={() => api.archiveExperiment(experiment.id).then(onArchived)}
              >
                <Archive className="size-3" />
              </Button>
            </>
          )}
        </div>
      </div>
      {experiment.hypothesisMd && (
        <p className="line-clamp-2 text-xs text-muted-foreground">{experiment.hypothesisMd}</p>
      )}
    </div>
  );
}

function RunningExperimentCard({
  experiment,
  onChanged,
  onOpen,
}: {
  experiment: CurrentExperiment;
  onChanged: () => void;
  onOpen: () => void;
}) {
  const [ending, setEnding] = useState<"succeeded" | "failed" | null>(null);
  const [note, setNote] = useState("");

  const end = async (verdict: "succeeded" | "failed") => {
    await api.endExperiment(experiment.id, verdict, note.trim() || undefined);
    setEnding(null);
    setNote("");
    onChanged();
  };

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-orange-300 bg-orange-50/50 p-4 dark:border-orange-800 dark:bg-orange-950/50">
      <div className="flex items-baseline justify-between gap-2">
        <button className="min-w-0 text-left font-medium hover:underline" onClick={onOpen}>
          {experiment.title}
        </button>
        <Badge variant="outline">
          day {(experiment.daysRunning ?? 0) + 1}
          {experiment.plannedDurationDays ? ` of ~${experiment.plannedDurationDays}` : ""}
        </Badge>
      </div>
      {experiment.hypothesisMd && <p className="text-sm text-muted-foreground">{experiment.hypothesisMd}</p>}

      {experiment.tasks.length > 0 && (
        <ul className="flex flex-col gap-1">
          {experiment.tasks.map(t => (
            <TaskRowView key={t.id} task={t} onChanged={onChanged} />
          ))}
        </ul>
      )}

      {ending ? (
        <div className="flex flex-col gap-2">
          <Textarea
            placeholder={
              ending === "succeeded"
                ? "what changed? (optional)"
                : "what got in the way, and what would make the next attempt easier? (optional, future-you thanks you)"
            }
            value={note}
            onChange={e => setNote(e.target.value)}
          />
          <div className="flex gap-2">
            <Button size="sm" onClick={() => end(ending)}>
              {ending === "succeeded" ? "it took" : "log it, move on"}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setEnding(null)}>
              back
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={() => setEnding("succeeded")}>
            <Check className="size-3" /> succeeded
          </Button>
          <Button size="sm" variant="outline" onClick={() => setEnding("failed")}>
            <X className="size-3" /> didn't take
          </Button>
        </div>
      )}
    </div>
  );
}

function TaskRowView({ task, onChanged }: { task: TaskRow; onChanged: () => void }) {
  const done = task.status === "done";
  return (
    <li className="flex items-center justify-between gap-2 text-sm">
      <button
        className={cn("flex items-center gap-2 text-left", done && "text-muted-foreground line-through")}
        onClick={() => api.patchTask(task.id, done ? "scheduled" : "done").then(onChanged)}
      >
        <span
          className={cn(
            "flex size-4 items-center justify-center rounded border",
            done && "bg-primary text-primary-foreground",
          )}
        >
          {done && <Check className="size-3" />}
        </span>
        {task.title}
        {task.scheduledFor && (
          <span className="text-xs text-muted-foreground">{task.scheduledFor.slice(5, 16).replace("T", " ")}</span>
        )}
      </button>
      <Button
        size="sm"
        variant="ghost"
        title="copy a prompt to talk this task through in a fresh Claude thread"
        onClick={async () => {
          const md = await api.taskCopyPrompt(task.id);
          await navigator.clipboard.writeText(md);
        }}
      >
        <ClipboardCopy className="size-3" />
      </Button>
    </li>
  );
}

function ExperimentPromptButton() {
  const [state, setState] = useState<"idle" | "working" | "copied" | "error">("idle");
  return (
    <div className="flex items-center gap-2">
      <Button
        variant="ghost"
        size="sm"
        disabled={state === "working"}
        onClick={async () => {
          setState("working");
          try {
            const md = await api.experimentPrompt();
            await navigator.clipboard.writeText(md);
            setState("copied");
          } catch {
            setState("error");
          }
        }}
      >
        <ClipboardCopy className="size-3" />
        {state === "working"
          ? "generating…"
          : state === "copied"
            ? "copied — go rant in the Claude app"
            : "copy prompt for a new experiment rant"}
      </Button>
      {state === "error" && <span className="text-xs text-destructive">generation failed — try again</span>}
    </div>
  );
}
