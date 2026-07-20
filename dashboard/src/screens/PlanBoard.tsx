import { useState } from "react";
import { CalendarDays, Search, Target } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { api, type RecordDetail } from "@/lib/api";
import { useApiData } from "@/lib/useApiData";
import { cn } from "@/lib/utils";

// The main dashboard (spec §9): a display of the current state — the pick
// (monthly), the current weekly plan, the daily plans — with the manual
// completion CRUD that doubles as the habit/momentum signal, plus a records
// browser. All authoring happens in MCP conversations; approvals live on the
// separate review-inbox page.
export function PlanBoard({ tick, onChanged }: { tick: number; onChanged: () => void }) {
  const { data: weekly } = useApiData(() => api.weeklyBoard(), [tick]);
  const { data: daily } = useApiData(() => api.dailyPlans(), [tick]);
  const [openRecord, setOpenRecord] = useState<{ model: string; lineageId: string } | null>(null);

  const pick = weekly?.pick ?? null;
  const currentWeek = weekly?.plans?.[0] ?? null;
  const priorWeeks = (weekly?.plans ?? []).slice(1);

  return (
    <div className="flex flex-col gap-6">
      <PickCard pick={pick} onOpenRecord={(model, lineageId) => setOpenRecord({ model, lineageId })} />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base font-medium">
              <CalendarDays className="size-4" /> this week
              {currentWeek && <Badge variant="outline">{currentWeek.weekOf}</Badge>}
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            {currentWeek ? (
              <>
                <p className="font-medium">{currentWeek.theme}</p>
                {currentWeek.description && (
                  <p className="whitespace-pre-wrap text-sm text-muted-foreground">{currentWeek.description}</p>
                )}
                <ul className="mt-1 flex flex-col gap-1">
                  {currentWeek.items.map(item => (
                    <ItemRow
                      key={item.id}
                      text={item.text}
                      kind={item.kind}
                      doneAt={item.doneAt}
                      onToggle={done => api.toggleWeeklyItem(item.id, done).then(onChanged)}
                    />
                  ))}
                </ul>
              </>
            ) : (
              <Empty text="No weekly plan yet — run the weekly-plan conversation in Claude." />
            )}
            {priorWeeks.length > 0 && (
              <div className="mt-3 border-t pt-2 text-xs text-muted-foreground">
                {priorWeeks.slice(0, 4).map(w => (
                  <div key={w.id} className="flex items-center gap-2 py-0.5">
                    <span className="font-mono">{w.weekOf}</span>
                    <span className="truncate">{w.theme}</span>
                    <span>
                      {w.items.filter(i => i.doneAt).length}/{w.items.length} done
                    </span>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base font-medium">daily plans</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {(daily ?? []).slice(0, 3).map(plan => (
              <div key={plan.id} className="rounded-lg border p-3">
                <div className="flex items-center gap-2">
                  <Badge variant="outline">{plan.date}</Badge>
                  <span className="text-sm font-medium">{plan.theme}</span>
                </div>
                <ul className="mt-2 flex flex-col gap-1">
                  {plan.items.map(item => (
                    <ItemRow
                      key={item.id}
                      text={item.text}
                      kind={item.kind}
                      doneAt={item.doneAt}
                      onToggle={done => api.toggleDailyItem(item.id, done).then(onChanged)}
                    />
                  ))}
                </ul>
              </div>
            ))}
            {(daily ?? []).length === 0 && <Empty text="No daily plans yet — plan tomorrow in Claude." />}
          </CardContent>
        </Card>
      </div>

      <RecordsBrowser onOpen={(model, lineageId) => setOpenRecord({ model, lineageId })} />

      {openRecord && (
        <RecordDialog
          model={openRecord.model}
          lineageId={openRecord.lineageId}
          onClose={() => setOpenRecord(null)}
          onNavigate={(model, lineageId) => setOpenRecord({ model, lineageId })}
          onChanged={onChanged}
        />
      )}
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return <p className="rounded-lg border border-dashed px-3 py-4 text-center text-sm text-muted-foreground">{text}</p>;
}

function ItemRow({
  text,
  kind,
  doneAt,
  onToggle,
}: {
  text: string;
  kind: string;
  doneAt: string | null;
  onToggle: (done: boolean) => void;
}) {
  return (
    <li className="flex items-center gap-2 text-sm">
      <input type="checkbox" checked={doneAt !== null} onChange={e => onToggle(e.target.checked)} className="size-4" />
      <span className={cn("min-w-0 flex-1 truncate", doneAt && "text-muted-foreground line-through")}>{text}</span>
      <Badge variant="outline" className="text-[10px]">
        {kind}
      </Badge>
    </li>
  );
}

// The monthly level: the picked group with its theme, deadline clock, ranked
// goals (what they mean + why chosen), member ideas with done toggles.
function PickCard({
  pick,
  onOpenRecord,
}: {
  pick: { id: string; endDate: string | null; expired: boolean; groupLineageId: string } | null;
  onOpenRecord: (model: string, lineageId: string) => void;
}) {
  const { data: group, refresh } = useApiData(
    () => (pick ? api.recordDetail("experiment_group", pick.groupLineageId) : Promise.resolve(null)),
    [pick?.groupLineageId],
  );

  if (!pick) {
    return (
      <Card>
        <CardContent className="py-6">
          <Empty text="No current pick — run the prioritize conversation in Claude to choose your next experiment group." />
        </CardContent>
      </Card>
    );
  }

  const head = group?.head as { title?: string; theme?: string; description?: string } | undefined;
  const relations = group?.relations as
    | {
        goalSet?: { lineageId: string; title: string; description: string | null; rank: number | null }[];
        memberIdeas?: { lineageId: string; title: string; doneAt: string | null; membershipId: string }[];
      }
    | undefined;
  const daysLeft = pick.endDate
    ? Math.max(0, Math.round((new Date(pick.endDate).getTime() - Date.now()) / 86_400_000))
    : null;

  return (
    <Card className={cn(pick.expired && "border-amber-400")}>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2 text-base font-medium">
          <Target className="size-4" /> current focus: {head?.title ?? "…"}
          {head?.theme && <Badge>{head.theme}</Badge>}
          {pick.endDate && (
            <Badge variant={pick.expired ? "destructive" : "outline"}>
              {pick.expired ? "EXPIRED — reprioritize" : `${daysLeft} days left (until ${pick.endDate})`}
            </Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {head?.description && <p className="whitespace-pre-wrap text-sm text-muted-foreground">{head.description}</p>}
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <div>
            <h3 className="mb-1 text-sm font-medium">goals (why they're chosen)</h3>
            <ul className="flex flex-col gap-1">
              {(relations?.goalSet ?? []).map(goal => (
                <li key={goal.lineageId}>
                  <button
                    className="w-full rounded-md border px-2 py-1.5 text-left text-sm hover:bg-accent"
                    onClick={() => onOpenRecord("organized_goal", goal.lineageId)}
                  >
                    <span className="font-medium">
                      {goal.rank != null ? `${goal.rank + 1}. ` : ""}
                      {goal.title}
                    </span>
                    {goal.description && <span className="block truncate text-xs text-muted-foreground">{goal.description}</span>}
                  </button>
                </li>
              ))}
            </ul>
          </div>
          <div>
            <h3 className="mb-1 text-sm font-medium">experiment ideas</h3>
            <ul className="flex flex-col gap-1">
              {(relations?.memberIdeas ?? []).map(idea => (
                <li key={idea.lineageId} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="size-4"
                    checked={idea.doneAt !== null}
                    onChange={e => api.toggleGroupIdea(idea.membershipId, e.target.checked).then(refresh)}
                  />
                  <button
                    className={cn("min-w-0 flex-1 truncate text-left hover:underline", idea.doneAt && "text-muted-foreground line-through")}
                    onClick={() => onOpenRecord("experiment_idea", idea.lineageId)}
                  >
                    {idea.title}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function RecordsBrowser({ onOpen }: { onOpen: (model: string, lineageId: string) => void }) {
  const [query, setQuery] = useState("");
  const [submitted, setSubmitted] = useState("");
  const { data: results } = useApiData(() => api.searchRecords(submitted), [submitted]);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base font-medium">
          <Search className="size-4" /> records
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <form
          onSubmit={e => {
            e.preventDefault();
            setSubmitted(query);
          }}
        >
          <Input placeholder="search goals, habits, ideas, patterns, leisure…" value={query} onChange={e => setQuery(e.target.value)} />
        </form>
        <div className="flex flex-col gap-2">
          {Object.entries(results ?? {}).map(([model, rows]) => (
            <div key={model}>
              <h4 className="text-xs font-medium uppercase text-muted-foreground">{model.replaceAll("_", " ")}</h4>
              <div className="mt-1 flex flex-wrap gap-1.5">
                {rows.map(row => (
                  <button
                    key={row.lineageId}
                    className="rounded-full border px-2.5 py-1 text-xs hover:bg-accent"
                    onClick={() => onOpen(model, row.lineageId)}
                  >
                    {row.title}
                    {row.version > 1 && <span className="ml-1 text-muted-foreground">v{row.version}</span>}
                  </button>
                ))}
              </div>
            </div>
          ))}
          {Object.keys(results ?? {}).length === 0 && <Empty text="Nothing yet — records are born in Claude conversations via record_create." />}
        </div>
      </CardContent>
    </Card>
  );
}

// Record detail with lineage + relations + the originating rant.
function RecordDialog({
  model,
  lineageId,
  onClose,
  onNavigate,
  onChanged,
}: {
  model: string;
  lineageId: string;
  onClose: () => void;
  onNavigate: (model: string, lineageId: string) => void;
  onChanged: () => void;
}) {
  const { data: record } = useApiData<RecordDetail | null>(() => api.recordDetail(model, lineageId), [model, lineageId]);
  if (!record) return null;
  const head = record.head as { title?: string; description?: string };

  const relationList = (label: string, rows: { lineageId?: string; title?: string; why?: string; model?: string }[] | undefined, targetModel?: string) =>
    rows && rows.length > 0 ? (
      <div key={label}>
        <h4 className="text-xs font-medium uppercase text-muted-foreground">{label}</h4>
        <ul className="mt-1 flex flex-col gap-1">
          {rows.map((row, i) => (
            <li key={i} className="text-sm">
              <button
                className="text-left hover:underline"
                onClick={() => row.lineageId && onNavigate(row.model ?? targetModel ?? model, row.lineageId)}
              >
                {row.title}
              </button>
              {row.why && <span className="block text-xs italic text-muted-foreground">why: {row.why}</span>}
            </li>
          ))}
        </ul>
      </div>
    ) : null;

  const relations = record.relations as Record<string, { lineageId?: string; title?: string; why?: string }[]>;
  const RELATION_MODEL: Record<string, string> = {
    habits: "habit",
    patterns: "pattern_of_behavior",
    ideas: "experiment_idea",
    groups: "experiment_group",
    goals: "organized_goal",
    memberIdeas: "experiment_idea",
    goalSet: "organized_goal",
    eliminatingHabits: "habit",
    eliminatingGroups: "experiment_group",
    projects: "project",
    tasks: "task",
    environments: "environment_item",
  };

  return (
    <Dialog open onOpenChange={o => !o && (onClose(), onChanged())}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {head.title}
            <Badge variant="outline">{model.replaceAll("_", " ")}</Badge>
            {record.versions.length > 1 && <Badge>v{record.versions.length}</Badge>}
          </DialogTitle>
        </DialogHeader>
        {head.description && <p className="whitespace-pre-wrap text-sm">{head.description}</p>}
        <div className="flex flex-col gap-3">
          {Object.entries(relations)
            .filter(([, rows]) => Array.isArray(rows))
            .map(([key, rows]) => relationList(key.replace(/([A-Z])/g, " $1").toLowerCase(), rows, RELATION_MODEL[key]))}
        </div>
        {record.versions.length > 1 && (
          <div className="border-t pt-2 text-xs text-muted-foreground">
            {record.versions.map(v => (
              <div key={v.id}>
                v{v.version}: {(v as { description?: string }).description?.slice(0, 100) ?? "(no description)"}
              </div>
            ))}
          </div>
        )}
        {record.rant && (
          <div className="rounded-lg border bg-muted/40 p-3">
            <h4 className="text-xs font-medium uppercase text-muted-foreground">
              the rant behind this — {record.rant.title} ({(record.rant.date ?? "").slice(0, 10)})
            </h4>
            <div className="mt-2 flex max-h-64 flex-col gap-2 overflow-y-auto text-xs">
              {record.rant.messages.map((m, i) => (
                <p key={i} className={cn("whitespace-pre-wrap", m.role === "user" ? "" : "text-muted-foreground")}>
                  <span className="font-medium">{m.role === "user" ? "you: " : "claude: "}</span>
                  {m.content.slice(0, 600)}
                </p>
              ))}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
