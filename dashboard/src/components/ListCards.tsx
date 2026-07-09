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
import { api, type EnvironmentRow, type ExperienceRow, type HabitRow } from "@/lib/api";
import { useApiData } from "@/lib/useApiData";
import { cn } from "@/lib/utils";

// The self-map cards: habits (established + building), environment, and the
// append-only experiences log.
export function ListCards({ tick, onChanged }: { tick: number; onChanged: () => void }) {
  const { data: habits } = useApiData(() => api.habits(), [tick]);
  const { data: environment } = useApiData(() => api.environment(), [tick]);
  const { data: experiences } = useApiData(() => api.experiences(), [tick]);

  return (
    <>
      <HabitsCard habits={habits ?? []} onChanged={onChanged} />
      <EnvironmentCard items={environment ?? []} onChanged={onChanged} />
      <ExperiencesCard experiences={experiences ?? []} onChanged={onChanged} />
    </>
  );
}

function pill(extra?: string) {
  return cn("flex items-center justify-between rounded-full bg-muted px-3 py-1.5 text-sm", extra);
}

function HabitsCard({ habits, onChanged }: { habits: HabitRow[]; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const current = habits.filter(h => h.status === "established" || h.status === "building");
  const lapsed = habits.filter(h => h.status === "lapsed");
  return (
    <>
      <Card className="flex flex-col py-4">
        <CardHeader className="px-4">
          <div className="flex items-center justify-between">
            <CardTitle className="text-base font-medium">habits</CardTitle>
            <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>
              <Pencil className="size-3.5" />
            </Button>
          </div>
        </CardHeader>
        <CardContent className="flex flex-1 flex-col gap-1.5 px-4">
          {current.map(h => (
            <div
              key={h.id}
              className={pill(
                h.status === "building"
                  ? "bg-orange-100 dark:bg-orange-950" // being built by the running experiment
                  : h.valence === "bad"
                    ? "bg-red-50 dark:bg-red-950"
                    : "bg-emerald-100 dark:bg-emerald-950",
              )}
              title={h.note ?? undefined}
            >
              <span className="min-w-0 truncate">{h.title}</span>
              {h.status === "building" && <span className="ml-2 text-xs opacity-70">building</span>}
            </div>
          ))}
          {current.length === 0 && (
            <p className="rounded-lg border border-dashed px-3 py-2 text-center text-xs text-muted-foreground">
              the map of what you already do fills in from your rants
            </p>
          )}
        </CardContent>
      </Card>

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent className="flex w-full flex-col gap-4 overflow-y-auto sm:max-w-md">
          <SheetHeader>
            <SheetTitle>habits</SheetTitle>
            <SheetDescription>
              established is what you already do. building belongs to the running experiment and
              graduates only when it succeeds. lapsed is not a verdict — just the current truth.
            </SheetDescription>
          </SheetHeader>
          {[
            { title: "current", rows: current, action: { label: "lapsed", to: "lapsed" as const } },
            { title: "lapsed", rows: lapsed, action: { label: "actually still true", to: "established" as const } },
          ].map(
            section =>
              section.rows.length > 0 && (
                <section key={section.title} className="flex flex-col gap-2">
                  <h3 className="text-xs font-medium uppercase text-muted-foreground">{section.title}</h3>
                  {section.rows.map(h => (
                    <div key={h.id} className="flex items-center justify-between gap-2 rounded-lg border p-2">
                      <div className="min-w-0">
                        <p className="truncate text-sm">{h.title}</p>
                        {h.note && <p className="truncate text-xs text-muted-foreground">{h.note}</p>}
                      </div>
                      {h.status !== "building" && (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-6 shrink-0 px-2 text-xs"
                          onClick={() => api.patchHabit(h.id, { status: section.action.to }).then(onChanged)}
                        >
                          {section.action.label}
                        </Button>
                      )}
                    </div>
                  ))}
                </section>
              ),
          )}
        </SheetContent>
      </Sheet>
    </>
  );
}

function EnvironmentCard({ items, onChanged }: { items: EnvironmentRow[]; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const active = items.filter(e => e.status === "active");
  const removed = items.filter(e => e.status === "removed");
  return (
    <>
      <Card className="flex flex-col py-4">
        <CardHeader className="px-4">
          <div className="flex items-center justify-between">
            <CardTitle className="text-base font-medium">environment</CardTitle>
            <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>
              <Pencil className="size-3.5" />
            </Button>
          </div>
        </CardHeader>
        <CardContent className="flex flex-1 flex-col gap-1.5 px-4">
          {active.map(e => (
            <div key={e.id} className={pill()} title={e.note ?? undefined}>
              <span className="min-w-0 truncate">{e.title}</span>
              <span className="ml-2 text-xs opacity-60">
                {e.subKind === "obligation" ? "must" : e.subKind === "social" ? "people" : "setup"}
              </span>
            </div>
          ))}
          {active.length === 0 && (
            <p className="rounded-lg border border-dashed px-3 py-2 text-center text-xs text-muted-foreground">
              the systems that spark habits — guitar by the bed, improv on Thursdays
            </p>
          )}
        </CardContent>
      </Card>

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent className="flex w-full flex-col gap-4 overflow-y-auto sm:max-w-md">
          <SheetHeader>
            <SheetTitle>environment</SheetTitle>
            <SheetDescription>
              physical setups, obligations you signed up for, and the people structures around you.
            </SheetDescription>
          </SheetHeader>
          {[
            { title: "active", rows: active, action: { label: "remove", to: "removed" as const } },
            { title: "removed", rows: removed, action: { label: "restore", to: "active" as const } },
          ].map(
            section =>
              section.rows.length > 0 && (
                <section key={section.title} className="flex flex-col gap-2">
                  <h3 className="text-xs font-medium uppercase text-muted-foreground">{section.title}</h3>
                  {section.rows.map(e => (
                    <div key={e.id} className="flex items-center justify-between gap-2 rounded-lg border p-2">
                      <div className="min-w-0">
                        <p className="truncate text-sm">
                          {e.title} <span className="text-xs text-muted-foreground">({e.subKind})</span>
                        </p>
                        {e.note && <p className="truncate text-xs text-muted-foreground">{e.note}</p>}
                      </div>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-6 shrink-0 px-2 text-xs"
                        onClick={() => api.patchEnvironment(e.id, { status: section.action.to }).then(onChanged)}
                      >
                        {section.action.label}
                      </Button>
                    </div>
                  ))}
                </section>
              ),
          )}
        </SheetContent>
      </Sheet>
    </>
  );
}

function ExperiencesCard({
  experiences,
  onChanged,
}: {
  experiences: ExperienceRow[];
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const planned = experiences.filter(e => e.state === "planned");
  const had = experiences.filter(e => e.state === "had");
  return (
    <>
      <Card className="flex flex-col border-dashed py-4">
        <CardContent className="flex flex-1 flex-col items-center justify-center gap-2 px-4 text-muted-foreground">
          <p className="text-center text-sm">
            {had.length} experience{had.length === 1 ? "" : "s"} lived
            {planned.length > 0 && (
              <>
                <br />
                {planned.length} planned
              </>
            )}
          </p>
          <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
            open
          </Button>
        </CardContent>
      </Card>

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent className="flex w-full flex-col gap-4 overflow-y-auto sm:max-w-md">
          <SheetHeader>
            <SheetTitle>experiences</SheetTitle>
            <SheetDescription>append-only — a life doesn't get deleted.</SheetDescription>
          </SheetHeader>
          {planned.length > 0 && (
            <section className="flex flex-col gap-2">
              <h3 className="text-xs font-medium uppercase text-muted-foreground">planned</h3>
              {planned.map(e => (
                <div key={e.id} className="flex items-center justify-between gap-2 rounded-lg border p-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm">{e.title}</p>
                    {e.plannedFor && (
                      <p className="text-xs text-muted-foreground">{e.plannedFor.slice(0, 16).replace("T", " ")}</p>
                    )}
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 shrink-0 px-2 text-xs"
                    onClick={() => api.experienceHad(e.id).then(onChanged)}
                  >
                    it happened
                  </Button>
                </div>
              ))}
            </section>
          )}
          <section className="flex flex-col gap-2">
            <h3 className="text-xs font-medium uppercase text-muted-foreground">lived</h3>
            {had.map(e => (
              <div key={e.id} className="rounded-lg border p-2">
                <p className="text-sm">{e.title}</p>
                <p className="text-xs text-muted-foreground">
                  {e.hadAt?.slice(0, 10)}
                  {e.note ? ` — ${e.note}` : ""}
                </p>
              </div>
            ))}
            {had.length === 0 && <p className="text-sm text-muted-foreground">none logged yet.</p>}
          </section>
        </SheetContent>
      </Sheet>
    </>
  );
}
