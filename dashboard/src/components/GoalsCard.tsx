import { Pencil } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { api, type GoalRow } from "@/lib/api";
import { useApiData } from "@/lib/useApiData";
import { cn } from "@/lib/utils";
import { DetailModal } from "./DetailModal";

// Attempt heatmap: light green first try → dark forest after many. Scale caps
// at 5 — past that, the color has said what it needs to say.
const HEAT = [
  "bg-muted", // 0 attempts
  "bg-emerald-100 dark:bg-emerald-950",
  "bg-emerald-200 dark:bg-emerald-900",
  "bg-emerald-300 dark:bg-emerald-800",
  "bg-emerald-400 dark:bg-emerald-700",
  "bg-emerald-600 text-white dark:bg-emerald-600",
];

function heatClass(attempts: number): string {
  return HEAT[Math.min(attempts, HEAT.length - 1)]!;
}

export function GoalsCard({ tick, onChanged }: { tick: number; onChanged: () => void }) {
  const { data: goals } = useApiData(() => api.goals(), [tick]);
  const [editing, setEditing] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const { data: detail } = useApiData(
    () => (openId ? api.goal(openId) : Promise.resolve(null)),
    [openId, tick],
  );
  const active = (goals ?? []).filter(g => g.status === "active");
  const pool = (goals ?? []).filter(g => g.status === "backlog" || g.status === "dormant");
  const done = (goals ?? []).filter(g => g.status === "succeeded" || g.status === "irrelevant");

  return (
    <>
      <Card className="flex flex-col py-4">
        <CardHeader className="px-4">
          <div className="flex items-center justify-between">
            <CardTitle className="text-base font-medium">goals</CardTitle>
            <Button variant="ghost" size="sm" onClick={() => setEditing(true)}>
              <Pencil className="size-3.5" />
            </Button>
          </div>
        </CardHeader>
        <CardContent className="flex flex-1 flex-col gap-1.5 px-4">
          {active.map(g => (
            <GoalPill key={g.id} goal={g} onOpen={() => setOpenId(g.id)} />
          ))}
          {active.length === 0 && (
            <p className="rounded-lg border border-dashed px-3 py-2 text-center text-xs text-muted-foreground">
              nothing active — approve a goal proposal or promote one from the pool
            </p>
          )}
        </CardContent>
      </Card>

      <Sheet open={editing} onOpenChange={setEditing}>
        <SheetContent className="flex w-full flex-col gap-4 overflow-y-auto sm:max-w-md">
          <SheetHeader>
            <SheetTitle>goals</SheetTitle>
            <SheetDescription>
              heat = how many experiments have tackled it. dark green isn't failure; it's a goal
              that needs a smaller first move.
            </SheetDescription>
          </SheetHeader>
          <GoalSection title="active" goals={active} onChanged={onChanged} onOpen={setOpenId} actions={g => [
            { label: "→ backlog", to: "backlog" },
            { label: "succeeded", to: "succeeded" },
            { label: "no longer relevant", to: "irrelevant" },
          ]} />
          <GoalSection title="the pool" goals={pool} onChanged={onChanged} onOpen={setOpenId} actions={g => [
            { label: "→ active", to: "active" },
            { label: "no longer relevant", to: "irrelevant" },
          ]} />
          <GoalSection title="finished (both kinds of success)" goals={done} onChanged={onChanged} onOpen={setOpenId} actions={() => []} />
        </SheetContent>
      </Sheet>

      {openId && detail && (
        <DetailModal
          open
          onClose={() => setOpenId(null)}
          kindLabel={`goal · ${detail.status} · ${detail.attemptCount} attempt${detail.attemptCount === 1 ? "" : "s"}`}
          title={detail.identityClause ?? detail.title}
          detail={detail.synthesisMd}
          relations={{
            experiments: detail.experiments,
            habits: detail.idealHabits.map(h => ({ id: h.id, title: h.title, status: h.status })),
            environment: detail.idealEnvironment.map(e => ({ id: e.id, title: e.title, status: e.status })),
          }}
          calendar={detail.schedule}
          evidence={detail.evidence.filter(n => n.note)}
          pendingProposals={detail.pendingProposals}
          extractions={detail.extractions}
        />
      )}
    </>
  );
}

function GoalPill({ goal, onOpen }: { goal: GoalRow; onOpen?: () => void }) {
  return (
    <button
      className={cn(
        "flex w-full items-center justify-between rounded-full px-3 py-1.5 text-left text-sm",
        heatClass(goal.attemptCount),
        onOpen && "cursor-pointer hover:opacity-80",
      )}
      title={
        goal.identityClause ??
        (goal.attemptCount ? `${goal.attemptCount} attempt${goal.attemptCount === 1 ? "" : "s"}` : undefined)
      }
      onClick={onOpen}
      disabled={!onOpen}
    >
      <span className="min-w-0 truncate">{goal.title}</span>
      {goal.attemptCount > 0 && <span className="ml-2 text-xs opacity-70">×{goal.attemptCount}</span>}
    </button>
  );
}

function GoalSection({
  title,
  goals,
  onChanged,
  onOpen,
  actions,
}: {
  title: string;
  goals: GoalRow[];
  onChanged: () => void;
  onOpen: (id: string) => void;
  actions: (g: GoalRow) => { label: string; to: string }[];
}) {
  if (!goals.length) return null;
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-xs font-medium uppercase text-muted-foreground">{title}</h3>
      {goals.map(g => (
        <div key={g.id} className="flex flex-col gap-1 rounded-lg border p-2">
          <GoalPill goal={g} onOpen={() => onOpen(g.id)} />
          {g.identityClause && <p className="px-1 text-xs italic text-muted-foreground">{g.identityClause}</p>}
          {(g.habits.length > 0 || g.environmentItems.length > 0) && (
            <p className="px-1 text-xs text-muted-foreground">
              ideal set: {[...g.habits.map(h => h.title), ...g.environmentItems.map(e => e.title)].join(", ")}
            </p>
          )}
          <div className="flex flex-wrap gap-1">
            {actions(g).map(a => (
              <Button
                key={a.to}
                size="sm"
                variant="ghost"
                className="h-6 px-2 text-xs"
                onClick={() => api.patchGoalStatus(g.id, a.to).then(onChanged)}
              >
                {a.label}
              </Button>
            ))}
          </div>
        </div>
      ))}
    </section>
  );
}
