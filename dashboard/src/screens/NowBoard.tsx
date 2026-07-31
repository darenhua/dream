import { useEffect, useRef, useState } from "react";
import { CalendarClock, ChevronRight, Flame, ListTodo, PartyPopper, Sparkles } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { plans } from "@/lib/api";
import type { ChainRunStepRow, NowPayload, TodayPayload, WeekPayload, WinsPayload } from "@/lib/api";
import { useApiData } from "@/lib/useApiData";

// The mobile-first execution dashboard (PLANNING_REVAMP_SPEC §7). The now
// screen never shows a wall of todos: inside a cue block it walks ONE chain
// step at a time (tap → green → pan down); outside one it shows the theme,
// the next cue, and the minimum viable day. Wins are a party, never a shame
// surface — no strikes anywhere.

const KIND_LABEL: Record<string, string> = {
  action: "actions",
  created: "created & shipped",
  courage: "courage",
  selfcare: "self-care",
  identity: "identity evidence",
  recognition: "self-recognition",
  lesson: "lessons",
};

const STEP_KIND_STYLE: Record<ChainRunStepRow["kind"], string> = {
  starter: "border-sky-300 dark:border-sky-800",
  warmup: "border-border",
  core: "border-border",
  reward: "border-amber-300 dark:border-amber-800",
};

function fmtTime(iso: string) {
  return new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

/** A full-text card: glanceability contract — never truncate without a
 * modal; tapping any card opens the complete text. */
function GlanceCard({
  label,
  value,
  detail,
  className = "",
}: {
  label: string;
  value: string | null | undefined;
  detail?: string | null;
  className?: string;
}) {
  if (!value) return null;
  return (
    <Dialog>
      <DialogTrigger asChild>
        <button className={`w-full rounded-xl border bg-card p-3 text-left ${className}`}>
          <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</div>
          <div className="mt-0.5 break-words text-sm font-medium leading-snug">{value}</div>
        </button>
      </DialogTrigger>
      <DialogContent className="max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-base">{label}</DialogTitle>
          <DialogDescription className="whitespace-pre-wrap break-words text-left text-sm text-foreground">
            {value}
            {detail ? `\n\n${detail}` : ""}
          </DialogDescription>
        </DialogHeader>
      </DialogContent>
    </Dialog>
  );
}

/** The chain walker: one decision at a time, momentum made visible. */
function ChainWalker({
  run,
  onToggle,
  onMinimum,
}: {
  run: NonNullable<NowPayload["run"]>;
  onToggle: (stepId: string, done: boolean) => void;
  onMinimum: () => void;
}) {
  const currentRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    currentRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [run.currentStepId]);

  const currentIdx = run.steps.findIndex(s => s.id === run.currentStepId);
  return (
    <div className="flex flex-col items-stretch gap-0">
      {run.steps.map((step, i) => {
        const done = step.doneAt != null;
        const isCurrent = step.id === run.currentStepId;
        const isPast = done;
        const isFuture = !done && !isCurrent;
        return (
          <div key={step.id} ref={isCurrent ? currentRef : undefined} className="flex flex-col items-stretch">
            {i > 0 && <div className={`mx-auto h-5 w-0.5 ${isPast || isCurrent ? "bg-emerald-400" : "bg-border"}`} />}
            <button
              onClick={() => {
                if (isCurrent) onToggle(step.id, true);
                else if (done && i === currentIdx - 1) onToggle(step.id, false); // undo the last tap
              }}
              className={[
                "w-full rounded-2xl border-2 p-4 text-left transition-all duration-300",
                done
                  ? "border-emerald-400 bg-emerald-50 dark:border-emerald-700 dark:bg-emerald-950"
                  : isCurrent
                    ? `scale-100 bg-card shadow-lg ${STEP_KIND_STYLE[step.kind]} border-foreground`
                    : `opacity-45 ${STEP_KIND_STYLE[step.kind]} bg-card`,
                isCurrent ? "min-h-24" : "",
              ].join(" ")}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-[11px] uppercase tracking-wide text-muted-foreground">
                  {step.kind}
                  {done ? " · done" : isCurrent ? " · tap when done" : ""}
                </span>
                {step.kind === "reward" && <PartyPopper className="size-4 text-amber-500" />}
              </div>
              <div className={`mt-1 break-words leading-snug ${isCurrent ? "text-lg font-semibold" : "text-sm"} ${done ? "text-emerald-900 line-through decoration-emerald-500/50 dark:text-emerald-200" : ""}`}>
                {step.text}
              </div>
              {isCurrent && isFuture === false && null}
            </button>
          </div>
        );
      })}
      {run.minimumVersion && !run.steps.every(s => s.doneAt) && (
        <button onClick={onMinimum} className="mt-4 w-full rounded-xl border border-dashed p-3 text-left">
          <div className="text-[11px] uppercase tracking-wide text-muted-foreground">minimum version — fully counts</div>
          <div className="mt-0.5 break-words text-sm">{run.minimumVersion}</div>
        </button>
      )}
    </div>
  );
}

function NowView({ tick, onChanged }: { tick: number; onChanged: () => void }) {
  const [pulse, setPulse] = useState(0);
  const { data, refresh } = useApiData<NowPayload>(() => plans.now(), [tick, pulse]);
  const { data: week } = useApiData<WeekPayload>(() => plans.week(), [tick]);

  // the now screen tracks real time: re-ask every 30s and on re-focus
  useEffect(() => {
    const interval = setInterval(() => setPulse(p => p + 1), 30_000);
    const onFocus = () => setPulse(p => p + 1);
    window.addEventListener("focus", onFocus);
    return () => {
      clearInterval(interval);
      window.removeEventListener("focus", onFocus);
    };
  }, []);

  if (!data) return null;
  const act = (fn: () => Promise<unknown>) => fn().then(() => refresh()).then(onChanged).catch(() => refresh());

  if (data.mode === "chain" && data.run && data.block) {
    return (
      <div className="space-y-4">
        <div className="rounded-xl border bg-card p-3">
          <div className="flex items-center justify-between gap-2">
            <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
              in the block · {fmtTime(data.block.startAt)}–{fmtTime(data.block.endAt)}
            </div>
            {data.theme && <Badge variant="secondary" className="max-w-[50%] truncate">{data.theme}</Badge>}
          </div>
          <div className="mt-1 break-words font-medium">
            when {data.run.trigger} <ChevronRight className="inline size-4" /> go
          </div>
        </div>
        <ChainWalker
          run={data.run}
          onToggle={(stepId, done) => act(() => plans.toggleStep(data.run!.id, stepId, done))}
          onMinimum={() => act(() => plans.minimumRun(data.run!.id))}
        />
        {data.run.reward && (
          <div className="text-center text-xs text-muted-foreground">reward waiting: {data.run.reward}</div>
        )}
      </div>
    );
  }

  const doneRuns = data.runsToday.filter(r => r.completedAt).length;
  return (
    <div className="space-y-3">
      {data.theme ? (
        <div className="rounded-2xl border bg-card p-5 text-center">
          <div className="text-[11px] uppercase tracking-wide text-muted-foreground">today</div>
          <div className="mt-1 break-words text-xl font-semibold leading-snug">{data.theme}</div>
          {data.weekDirection && <div className="mt-2 break-words text-xs text-muted-foreground">week: {data.weekDirection}</div>}
        </div>
      ) : (
        <div className="rounded-2xl border border-dashed p-5 text-center text-sm text-muted-foreground">
          no plan for today yet — run the daily conversation (≤5 min): review yesterday's wins, pick 2–3 chains
        </div>
      )}

      {data.nextCue && (
        <div className="rounded-xl border bg-card p-3">
          <div className="flex items-center gap-2 text-[11px] uppercase tracking-wide text-muted-foreground">
            <CalendarClock className="size-3.5" /> next cue · in {data.nextCue.minutesUntil} min ({fmtTime(data.nextCue.startAt)})
          </div>
          <div className="mt-0.5 break-words text-sm font-medium">{data.nextCue.title}</div>
        </div>
      )}

      <GlanceCard label="top priority" value={data.topPriority} />
      <GlanceCard label="first domino" value={data.firstDomino} className="border-sky-300 dark:border-sky-800" />
      <GlanceCard label="minimum viable day — still a win" value={data.minimumViableDay} />

      <div className="flex items-center justify-between rounded-xl border bg-card p-3">
        <div className="text-sm">
          <Flame className="mr-1 inline size-4 text-amber-500" />
          {doneRuns}/{data.runsToday.length} chains · {data.winsToday} wins today
        </div>
        {week?.chains && week.chains.length > 0 && (
          <Dialog>
            <DialogTrigger asChild>
              <Button size="sm" variant="outline">extra chain</Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle className="text-base">got more in you? pick a chain</DialogTitle>
                <DialogDescription>an extra rep toward the theme — it logs its own win, nothing else to manage</DialogDescription>
              </DialogHeader>
              <div className="space-y-2">
                {week.chains.filter(c => c.status === "active").map(c => (
                  <Button
                    key={c.lineageId}
                    variant="outline"
                    className="h-auto w-full justify-start whitespace-normal break-words py-2 text-left"
                    onClick={() => act(() => plans.adhocRun(c.lineageId))}
                  >
                    when {c.trigger} → …
                  </Button>
                ))}
              </div>
            </DialogContent>
          </Dialog>
        )}
      </div>

      {data.month?.theme && (
        <div className="text-center text-xs text-muted-foreground">
          month: {data.month.theme}
          {data.month.endDate ? ` · until ${data.month.endDate}` : ""}
        </div>
      )}
    </div>
  );
}

function DayView({ tick, onChanged }: { tick: number; onChanged: () => void }) {
  const { data, refresh } = useApiData<TodayPayload>(() => plans.today(), [tick]);
  const [parking, setParking] = useState("");
  if (!data) return null;
  const plan = data.plan;
  return (
    <div className="space-y-3">
      {!plan && (
        <div className="rounded-2xl border border-dashed p-5 text-center text-sm text-muted-foreground">
          no plan for today — the daily conversation creates it
        </div>
      )}
      {plan && (
        <>
          <GlanceCard label="theme" value={plan.theme} detail={plan.description} />
          <GlanceCard label="top priority" value={plan.topPriority} />
          <div className="grid grid-cols-2 gap-2">
            <GlanceCard label="health" value={plan.supportingHealth} />
            <GlanceCard label="connection" value={plan.supportingConnection} />
          </div>
          <GlanceCard label="first domino" value={plan.firstDomino} />
          <GlanceCard label="minimum viable day" value={plan.minimumViableDay} />
        </>
      )}

      {data.runs.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">today's chains</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {data.runs.map(run => (
              <div key={run.id} className="rounded-lg border p-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="break-words text-sm font-medium">when {run.chain?.trigger}</span>
                  <Badge variant={run.completedAt ? "default" : "secondary"}>
                    {run.completedAt ? (run.minimumOnly ? "done (min)" : "done") : `${run.steps.filter(s => s.doneAt).length}/${run.steps.length}`}
                  </Badge>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">parking lot — saved, not acted on</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {(plan?.parkingLot ?? []).map((item, i) => (
            <div key={i} className="break-words rounded-lg border p-2 text-sm">{item}</div>
          ))}
          <form
            className="flex gap-2"
            onSubmit={e => {
              e.preventDefault();
              if (!parking.trim() || !plan) return;
              plans.addParking(parking.trim()).then(() => {
                setParking("");
                refresh();
                onChanged();
              });
            }}
          >
            <Input
              value={parking}
              onChange={e => setParking(e.target.value)}
              placeholder={plan ? "park a distraction…" : "needs a plan first"}
              disabled={!plan}
            />
            <Button type="submit" variant="outline" disabled={!plan || !parking.trim()}>park</Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}

function WeekView({ tick }: { tick: number }) {
  const { data } = useApiData<WeekPayload>(() => plans.week(), [tick]);
  if (!data) return null;
  if (!data.week)
    return (
      <div className="rounded-2xl border border-dashed p-5 text-center text-sm text-muted-foreground">
        no weekly plan yet — the weekly session builds the chains and the week
      </div>
    );
  const w = data.week;
  return (
    <div className="space-y-3">
      <GlanceCard label={`week of ${w.weekOf}`} value={w.direction ?? w.theme} detail={w.description} />
      {w.topOutcomes.length > 0 && (
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm">top outcomes</CardTitle></CardHeader>
          <CardContent className="space-y-1.5">
            {w.topOutcomes.map((o, i) => (
              <div key={i} className="break-words rounded-lg border p-2 text-sm">{o}</div>
            ))}
          </CardContent>
        </Card>
      )}
      <div className="grid grid-cols-1 gap-2">
        <GlanceCard label="the fear to face" value={w.fearToFace} className="border-rose-300 dark:border-rose-900" />
        <GlanceCard label="a successful week is" value={w.successDefinition} />
        <div className="grid grid-cols-2 gap-2">
          <GlanceCard label="health" value={w.healthPriority} />
          <GlanceCard label="social" value={w.socialPriority} />
        </div>
      </div>
      {data.chains && data.chains.length > 0 && (
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm">the week's chains</CardTitle></CardHeader>
          <CardContent className="space-y-1.5">
            {data.chains.map(c => (
              <div key={c.lineageId} className="flex items-center justify-between gap-2 rounded-lg border p-2">
                <span className="break-words text-sm">when {c.trigger}</span>
                <Badge variant={c.status === "active" ? "default" : "secondary"}>{c.status}</Badge>
              </div>
            ))}
          </CardContent>
        </Card>
      )}
      {w.failurePoints.length > 0 && (
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm">if it breaks → the recovery</CardTitle></CardHeader>
          <CardContent className="space-y-1.5">
            {w.failurePoints.map((f, i) => (
              <div key={i} className="rounded-lg border p-2 text-sm">
                <div className="break-words font-medium">{f.point}</div>
                <div className="mt-0.5 break-words text-muted-foreground">→ {f.recovery}</div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}
      {w.candidateMissions.length > 0 && (
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm">candidate daily missions</CardTitle></CardHeader>
          <CardContent className="space-y-1.5">
            {w.candidateMissions.map((m, i) => (
              <div key={i} className="break-words rounded-lg border p-2 text-sm">{m}</div>
            ))}
          </CardContent>
        </Card>
      )}
      {data.month?.theme && (
        <div className="text-center text-xs text-muted-foreground">month: {data.month.theme}{data.month.endDate ? ` · until ${data.month.endDate}` : ""}</div>
      )}
    </div>
  );
}

function WinsView({ tick }: { tick: number }) {
  const [scope, setScope] = useState<"day" | "week" | "month">("day");
  const { data } = useApiData<WinsPayload>(() => plans.wins(scope), [tick, scope]);
  return (
    <div className="space-y-3">
      <div className="flex gap-1 rounded-xl border bg-card p-1">
        {(["day", "week", "month"] as const).map(s => (
          <Button key={s} size="sm" variant={scope === s ? "secondary" : "ghost"} className="flex-1" onClick={() => setScope(s)}>
            {s}
          </Button>
        ))}
      </div>
      {data && (
        <>
          <div className="rounded-2xl border bg-card p-4 text-center">
            <PartyPopper className="mx-auto size-6 text-amber-500" />
            <div className="mt-1 text-2xl font-semibold">{data.entries.length} wins</div>
            <div className="text-xs text-muted-foreground">
              {data.runs.completed} chains run{data.runs.minimum > 0 ? ` · ${data.runs.minimum} minimum (they count)` : ""}
            </div>
          </div>
          {Object.entries(data.byKind).map(([kind, entries]) => (
            <Card key={kind}>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">
                  <Sparkles className="mr-1 inline size-3.5 text-amber-500" />
                  {KIND_LABEL[kind] ?? kind}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-1.5">
                {entries.map((e, i) => (
                  <div key={i} className="rounded-lg border p-2 text-sm">
                    <div className="break-words">{e.text}</div>
                    <div className="mt-0.5 text-[10px] text-muted-foreground">{e.date}{e.source === "auto" ? " · from a chain" : ""}</div>
                  </div>
                ))}
              </CardContent>
            </Card>
          ))}
          {data.entries.length === 0 && (
            <div className="rounded-2xl border border-dashed p-5 text-center text-sm text-muted-foreground">
              nothing here yet — evidence lands as you tap through chains and review your day
            </div>
          )}
        </>
      )}
    </div>
  );
}

const TABS = [
  { key: "now", label: "now", icon: Flame },
  { key: "day", label: "day", icon: ListTodo },
  { key: "week", label: "week", icon: CalendarClock },
  { key: "wins", label: "wins", icon: PartyPopper },
] as const;
type Tab = (typeof TABS)[number]["key"];

export function NowBoard({ tick, onChanged }: { tick: number; onChanged: () => void }) {
  const [tab, setTab] = useState<Tab>("now");
  return (
    <div className="mx-auto w-full max-w-md">
      <div className="pb-20">
        {tab === "now" && <NowView tick={tick} onChanged={onChanged} />}
        {tab === "day" && <DayView tick={tick} onChanged={onChanged} />}
        {tab === "week" && <WeekView tick={tick} />}
        {tab === "wins" && <WinsView tick={tick} />}
      </div>
      <nav className="fixed inset-x-0 bottom-0 border-t bg-background/95 pb-[env(safe-area-inset-bottom)] backdrop-blur">
        <div className="mx-auto flex max-w-md">
          {TABS.map(({ key, label, icon: Icon }) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              className={`flex flex-1 flex-col items-center gap-0.5 py-2.5 text-[11px] ${tab === key ? "text-foreground" : "text-muted-foreground"}`}
            >
              <Icon className={`size-5 ${tab === key ? "" : "opacity-60"}`} />
              {label}
            </button>
          ))}
        </div>
      </nav>
    </div>
  );
}
