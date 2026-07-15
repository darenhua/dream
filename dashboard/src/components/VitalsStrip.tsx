import { Activity, FlaskConical, Inbox, PauseCircle, TriangleAlert } from "lucide-react";

import { api } from "@/lib/api";
import { useApiData } from "@/lib/useApiData";
import { cn } from "@/lib/utils";

// Self-visibility before social visibility: every derived signal the strike
// engine reads — and the strike count itself — shown to the user first.
// A quiet strip when all is well; it only gets loud when the clocks do.
export function VitalsStrip({ tick }: { tick: number }) {
  const { data } = useApiData(() => api.vitals(), [tick]);
  if (!data) return null;
  const { vitals: v, strikes: s } = data;

  const chips: { icon: React.ReactNode; text: string; tone?: "warn" | "bad" }[] = [];

  if (v.daysSinceLastRant !== null) {
    chips.push({
      icon: <Inbox className="size-3.5" />,
      text: v.daysSinceLastRant === 0 ? "intake: fed today" : `intake: ${v.daysSinceLastRant}d quiet`,
      tone: s.rantStrikes > 0 ? "warn" : undefined,
    });
  }

  if (v.experiment.running) {
    chips.push({
      icon: <FlaskConical className="size-3.5" />,
      text: `experiment: day ${v.experiment.running.dayN}${v.experiment.running.plannedDurationDays ? `/${v.experiment.running.plannedDurationDays}` : ""}`,
    });
  } else if (v.experiment.queueDepth > 0) {
    chips.push({ icon: <FlaskConical className="size-3.5" />, text: `queue: ${v.experiment.queueDepth} ready` });
  } else if (v.experiment.daysSinceEnded !== null) {
    chips.push({
      icon: <FlaskConical className="size-3.5" />,
      text: `engine: empty ${v.experiment.daysSinceEnded}d`,
      tone: s.queueStrikes > 0 ? "warn" : undefined,
    });
  }

  if (s.paused) {
    chips.push({ icon: <PauseCircle className="size-3.5" />, text: `paused until ${s.pausedUntil}` });
  } else if (s.total > 0) {
    chips.push({
      icon: <TriangleAlert className="size-3.5" />,
      text: `${s.total} strike${s.total === 1 ? "" : "s"}`,
      tone: "bad",
    });
  }

  if (chips.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
      <Activity className="size-3.5" />
      {chips.map((chip, i) => (
        <span
          key={i}
          className={cn(
            "flex items-center gap-1 rounded-full border px-2 py-0.5",
            chip.tone === "warn" && "border-amber-300 text-amber-700 dark:border-amber-800 dark:text-amber-300",
            chip.tone === "bad" && "border-red-300 text-red-700 dark:border-red-800 dark:text-red-300",
          )}
        >
          {chip.icon}
          {chip.text}
        </span>
      ))}
      {s.queueNudge && (
        <span className="text-amber-700 dark:text-amber-300">
          the queue's empty and this experiment is winding down — worth shaping the next one
        </span>
      )}
    </div>
  );
}
