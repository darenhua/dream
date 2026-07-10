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
import { DetailModal } from "./DetailModal";

type OpenEntity = { type: "habit" | "environment" | "experience"; id: string } | null;

// The self-map cards: habits (established + building), environment, and the
// append-only experiences log. Every item clicks into the shared detail modal.
export function ListCards({ tick, onChanged }: { tick: number; onChanged: () => void }) {
  const { data: habits } = useApiData(() => api.habits(), [tick]);
  const { data: environment } = useApiData(() => api.environment(), [tick]);
  const { data: experiences } = useApiData(() => api.experiences(), [tick]);
  const [open, setOpen] = useState<OpenEntity>(null);

  return (
    <>
      <HabitsCard habits={habits ?? []} onChanged={onChanged} onOpen={id => setOpen({ type: "habit", id })} />
      <EnvironmentCard
        items={environment ?? []}
        onChanged={onChanged}
        onOpen={id => setOpen({ type: "environment", id })}
      />
      <ExperiencesCard
        experiences={experiences ?? []}
        onChanged={onChanged}
        onOpen={id => setOpen({ type: "experience", id })}
      />
      {open && <EntityModalHost entity={open} tick={tick} onClose={() => setOpen(null)} />}
    </>
  );
}

// Fetches the right detail endpoint and maps it onto the shared modal.
function EntityModalHost({ entity, tick, onClose }: { entity: NonNullable<OpenEntity>; tick: number; onClose: () => void }) {
  const { data } = useApiData(() => {
    if (entity.type === "habit") return api.habit(entity.id);
    if (entity.type === "environment") return api.environmentItem(entity.id);
    return api.experience(entity.id);
  }, [entity.type, entity.id, tick]);
  if (!data) return null;

  if (entity.type === "habit") {
    const h = data as Awaited<ReturnType<typeof api.habit>>;
    return (
      <DetailModal
        open
        onClose={onClose}
        kindLabel={`habit · ${h.status}${h.valence === "bad" ? " · bad" : ""}`}
        title={h.title}
        detail={h.note}
        relations={{
          goals: h.goals,
          experiments: h.bornInExperiment ? [h.bornInExperiment] : undefined,
        }}
        calendar={h.calendarEvents}
        extractions={h.extractions}
      />
    );
  }
  if (entity.type === "environment") {
    const e = data as Awaited<ReturnType<typeof api.environmentItem>>;
    return (
      <DetailModal
        open
        onClose={onClose}
        kindLabel={`environment · ${e.subKind} · ${e.status}`}
        title={e.title}
        detail={e.note}
        relations={{ goals: e.goals }}
        calendar={e.calendarEvents}
        extractions={e.extractions}
      />
    );
  }
  const x = data as Awaited<ReturnType<typeof api.experience>>;
  return (
    <DetailModal
      open
      onClose={onClose}
      kindLabel={`experience · ${x.state}${x.hadAt ? ` · ${x.hadAt.slice(0, 10)}` : ""}`}
      title={x.title}
      detail={x.note}
      relations={{ experiments: x.fromExperiment ? [x.fromExperiment] : undefined }}
      calendar={x.calendarEvents}
      extractions={x.extractions}
    />
  );
}

function pill(extra?: string) {
  return cn("flex items-center justify-between rounded-full bg-muted px-3 py-1.5 text-sm", extra);
}

function HabitsCard({
  habits,
  onChanged,
  onOpen,
}: {
  habits: HabitRow[];
  onChanged: () => void;
  onOpen: (id: string) => void;
}) {
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
            <button
              key={h.id}
              className={cn(
                pill(
                  h.status === "building"
                    ? "bg-orange-100 dark:bg-orange-950" // being built by the running experiment
                    : h.valence === "bad"
                      ? "bg-red-50 dark:bg-red-950"
                      : "bg-emerald-100 dark:bg-emerald-950",
                ),
                "w-full cursor-pointer text-left hover:opacity-80",
              )}
              title={h.note ?? undefined}
              onClick={() => onOpen(h.id)}
            >
              <span className="min-w-0 truncate">{h.title}</span>
              {h.status === "building" && <span className="ml-2 text-xs opacity-70">building</span>}
            </button>
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

function EnvironmentCard({
  items,
  onChanged,
  onOpen,
}: {
  items: EnvironmentRow[];
  onChanged: () => void;
  onOpen: (id: string) => void;
}) {
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
            <button
              key={e.id}
              className={cn(pill(), "w-full cursor-pointer text-left hover:opacity-80")}
              title={e.note ?? undefined}
              onClick={() => onOpen(e.id)}
            >
              <span className="min-w-0 truncate">{e.title}</span>
              <span className="ml-2 text-xs opacity-60">
                {e.subKind === "obligation" ? "must" : e.subKind === "social" ? "people" : "setup"}
              </span>
            </button>
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
  onOpen,
}: {
  experiences: ExperienceRow[];
  onChanged: () => void;
  onOpen: (id: string) => void;
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
              <button key={e.id} className="rounded-lg border p-2 text-left hover:bg-muted/50" onClick={() => onOpen(e.id)}>
                <p className="text-sm">{e.title}</p>
                <p className="text-xs text-muted-foreground">
                  {e.hadAt?.slice(0, 10)}
                  {e.note ? ` — ${e.note}` : ""}
                </p>
              </button>
            ))}
            {had.length === 0 && <p className="text-sm text-muted-foreground">none logged yet.</p>}
          </section>
        </SheetContent>
      </Sheet>
    </>
  );
}
