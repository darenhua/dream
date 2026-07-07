import { useState } from "react";
import { Check, Copy, MoveRight, Sprout } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { api, type ExperimentRow, type WriteupRow } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { Intention } from "../data";

interface ExperimentCardProps {
  experiment: ExperimentRow | null;
  writeup: WriteupRow | null;
  onChanged: () => void | Promise<void>;
  className?: string;
}

export function ExperimentCard({ experiment, writeup, onChanged, className }: ExperimentCardProps) {
  const live = experiment?.isLive ? experiment : null;

  return (
    <Card className={className}>
      <CardContent className="flex flex-col gap-6 md:flex-row">
        <div className="flex min-w-0 flex-col gap-5 md:basis-[70%]">
          {live ? <LiveExperiment experiment={live} onChanged={onChanged} /> : <StartFlow last={experiment} onChanged={onChanged} />}
        </div>
        <div
          className={cn(
            "flex min-w-0 items-center justify-center overflow-hidden rounded-2xl bg-muted/50 p-6 md:basis-[30%]",
          )}
        >
          {/* The daily 3-sentence writeup — the glance bait — lives here. */}
          <blockquote className="min-w-0 border-l-2 pl-4">
            {writeup ? (
              <>
                <p className="line-clamp-6 break-words text-sm italic leading-relaxed md:text-base">
                  {writeup.text}
                </p>
                <footer className="mt-2 truncate text-sm text-muted-foreground">
                  — dream coach · {writeup.date}
                </footer>
              </>
            ) : (
              <p className="text-sm italic text-muted-foreground">
                No writeup yet — it appears after the first daily run.
              </p>
            )}
          </blockquote>
        </div>
      </CardContent>
    </Card>
  );
}

function LiveExperiment({
  experiment,
  onChanged,
}: {
  experiment: ExperimentRow;
  onChanged: () => void | Promise<void>;
}) {
  const [ending, setEnding] = useState<"done" | "composted" | null>(null);
  const [note, setNote] = useState("");
  const intentions = (JSON.parse(experiment.actionsJson) as Intention[]).slice(0, 3);

  const end = async () => {
    if (!ending) return;
    await api.endExperiment(experiment.id, ending, note.trim() || undefined);
    setEnding(null);
    setNote("");
    await onChanged();
  };

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-semibold">
          {experiment.title}
          {/* days running is neutral info — never overdue styling */}
          <span className="font-normal text-muted-foreground"> · day {experiment.daysRunning ?? 0}</span>
        </h2>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => setEnding("done")}>
            <Check /> done
          </Button>
          <Button variant="outline" size="sm" onClick={() => setEnding("composted")}>
            <Sprout /> compost
          </Button>
        </div>
      </div>
      {ending && (
        <div className="flex flex-col gap-2 rounded-lg border p-3 sm:flex-row sm:items-center">
          <Input
            placeholder={
              ending === "done" ? "optional: how did it go?" : "optional: why didn't it fit? (blameless)"
            }
            value={note}
            onChange={e => setNote(e.target.value)}
            className="flex-1"
          />
          <div className="flex gap-2">
            <Button size="sm" onClick={end}>
              {ending === "done" ? "finish" : "compost"}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setEnding(null)}>
              cancel
            </Button>
          </div>
        </div>
      )}
      <ul className="flex flex-1 flex-col justify-center gap-4">
        {intentions.map(intention => (
          <li
            key={intention.when}
            className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-xl font-medium md:text-2xl"
          >
            <span>
              <span className="text-muted-foreground">When </span>
              {intention.when}
            </span>
            <MoveRight className="size-5 shrink-0 self-center text-muted-foreground" />
            <span>{intention.then}</span>
          </li>
        ))}
      </ul>
    </>
  );
}

// No live experiment: copy the prompt package into a fresh Claude chat, paste
// the JSON back, commit. Fallow season is fine — nothing here nags.
function StartFlow({
  last,
  onChanged,
}: {
  last: ExperimentRow | null;
  onChanged: () => void | Promise<void>;
}) {
  const [copied, setCopied] = useState(false);
  const [pasted, setPasted] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]> | null>(null);
  const [busy, setBusy] = useState(false);

  const copyPackage = async () => {
    try {
      const markdown = await api.promptPackage();
      await navigator.clipboard.writeText(markdown);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch (e) {
      setFieldErrors({ "(package)": [e instanceof Error ? e.message : String(e)] });
    }
  };

  const submit = async () => {
    setBusy(true);
    setFieldErrors(null);
    try {
      const result = await api.createDraft(pasted);
      if (!result.ok) {
        setFieldErrors(result.fieldErrors);
        return;
      }
      await api.commitExperiment(result.experiment.id);
      setPasted("");
      await onChanged();
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <h2 className="text-lg font-semibold">
        no experiment running
        <span className="font-normal text-muted-foreground"> · fallow season is allowed</span>
      </h2>
      {last && (
        <p className="text-sm text-muted-foreground">
          last: “{last.title}” ({last.status})
        </p>
      )}
      <div className="flex flex-col gap-3">
        <div>
          <Button variant="outline" onClick={copyPackage}>
            <Copy /> {copied ? "copied — paste into a fresh Claude chat" : "copy prompt package"}
          </Button>
        </div>
        <Textarea
          placeholder='when the conversation ends, paste the JSON block here ({"title": ...})'
          value={pasted}
          onChange={e => setPasted(e.target.value)}
          className="min-h-24 font-mono text-xs"
        />
        {fieldErrors && (
          <ul className="text-sm text-destructive">
            {Object.entries(fieldErrors).map(([field, errors]) => (
              <li key={field}>
                <span className="font-mono">{field}</span>: {errors.join("; ")}
              </li>
            ))}
          </ul>
        )}
        <div>
          <Button onClick={submit} disabled={!pasted.trim() || busy}>
            begin experiment
          </Button>
        </div>
      </div>
    </>
  );
}
