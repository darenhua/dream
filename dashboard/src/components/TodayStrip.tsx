import { Badge } from "@/components/ui/badge";
import { api, type CalendarEventRow } from "@/lib/api";
import { useApiData } from "@/lib/useApiData";
import { cn } from "@/lib/utils";

// Today's schedule strip: dream-calendar blocks, experiment blocks visually
// distinct from the established garden.
const STYLE_CLASSES: Record<CalendarEventRow["blockStyle"], string> = {
  habit: "border-emerald-300 bg-emerald-50 dark:border-emerald-800 dark:bg-emerald-950",
  experiment: "border-orange-300 bg-orange-50 dark:border-orange-800 dark:bg-orange-950",
  obligation: "border-slate-300 bg-slate-50 dark:border-slate-700 dark:bg-slate-900",
  task: "border-amber-300 bg-amber-50 dark:border-amber-800 dark:bg-amber-950",
};

export function TodayStrip({ tick }: { tick: number }) {
  const { data, error } = useApiData(() => api.calendarToday(), [tick]);
  if (error || !data) return null;
  const events = [...data.events].sort((a, b) => a.startAt.localeCompare(b.startAt));
  if (!events.length && !data.needsReschedule.length) return null;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex gap-2 overflow-x-auto pb-1">
        {events.map(e => (
          <div
            key={e.id}
            className={cn(
              "flex shrink-0 flex-col rounded-lg border px-3 py-1.5 text-xs",
              STYLE_CLASSES[e.blockStyle],
            )}
          >
            <span className="font-medium">{e.title}</span>
            <span className="text-muted-foreground">
              {e.startAt.slice(11, 16)}
              {e.rrule ? " · recurring" : ""}
              {e.blockStyle === "experiment" ? " · building" : ""}
            </span>
          </div>
        ))}
      </div>
      {data.needsReschedule.length > 0 && (
        <p className="text-xs text-muted-foreground">
          waiting for a better day:{" "}
          {data.needsReschedule.map(e => (
            <Badge key={e.id} variant="outline" className="mr-1">
              {e.title}
            </Badge>
          ))}
        </p>
      )}
    </div>
  );
}
