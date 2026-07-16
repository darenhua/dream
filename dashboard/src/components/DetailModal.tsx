import { useMemo, useState, type ReactNode } from "react";
import { Loader2, MessageSquareText, Plus, Quote, Send } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  api,
  type CalendarEventRow,
  type CitedExtraction,
  type EntityRef,
  type EvidenceNote,
  type ExperimentRef,
  type ProposedChange,
  type TaskRow,
} from "@/lib/api";
import { useApiData } from "@/lib/useApiData";
import { cn } from "@/lib/utils";
import { EXTRACTION_KIND_LABELS } from "../data";

// One modal for proposals AND entities: it takes props and renders whichever
// objects exist — the rant explorer always; the checklist, relations, schedule,
// and evidence sections whenever the data model has them; the revision surface
// only for pending proposals.

export interface ScheduleInfo {
  tasks?: TaskRow[];
  plannedDurationDays?: number | null;
  startedAt?: string | null;
  bandwidth?: string | null;
}

export interface Relations {
  goals?: EntityRef[];
  experiments?: ExperimentRef[]; // attempt archaeology: status + outcome notes
  habits?: EntityRef[];
  environment?: EntityRef[];
  experiences?: EntityRef[];
  // The organized feed uses this optional bridge to show the raw records it
  // deliberately links to. Existing raw cards never supply it. A source can
  // be opened in its native raw detail modal, preserving the explicit
  // organized -> raw record -> extraction -> conversation path.
  sources?: (EntityRef & { onOpen?: () => void })[];
}

export interface DetailModalProps {
  open: boolean;
  onClose: () => void;
  kindLabel: string;
  title: string;
  detail?: string | null; // the mirror — rendered whole, never truncated
  checklist?: ProposedChange[] | null;
  relations?: Relations;
  evidence?: EvidenceNote[];
  calendar?: CalendarEventRow[];
  pendingProposals?: { id: string; kind: string; title: string }[];
  extractions: CitedExtraction[];
  schedule?: ScheduleInfo;
  revision?: { proposalId: string; onRevised: () => void };
  // Raw and organized detail views can opt into the final provenance hop:
  // cited extraction -> read-only source conversation. Keeping this optional
  // preserves existing callers that only need the citation explorer.
  onOpenConversation?: (conversationId: string) => void;
}

interface RantSource {
  conversationId: string;
  title: string;
  date: string;
  extractions: CitedExtraction[];
}

export function DetailModal({
  open,
  onClose,
  kindLabel,
  title,
  detail,
  checklist,
  relations,
  evidence,
  calendar,
  pendingProposals,
  extractions,
  schedule,
  revision,
  onOpenConversation,
}: DetailModalProps) {
  // Group cited extractions by their source rant — the vertical link list.
  const sources = useMemo<RantSource[]>(() => {
    const byConvo = new Map<string, RantSource>();
    for (const x of extractions) {
      if (!byConvo.has(x.conversationId)) {
        byConvo.set(x.conversationId, {
          conversationId: x.conversationId,
          title: x.conversationTitle ?? "(untitled)",
          date: (x.conversationDate ?? "").slice(0, 10),
          extractions: [],
        });
      }
      byConvo.get(x.conversationId)!.extractions.push(x);
    }
    return [...byConvo.values()];
  }, [extractions]);

  const [activeSource, setActiveSource] = useState<string | null>(null);
  const active = sources.find(s => s.conversationId === activeSource) ?? sources[0] ?? null;
  const [adding, setAdding] = useState(false);

  return (
    <Dialog open={open} onOpenChange={o => !o && onClose()}>
      <DialogContent className="flex max-h-[85vh] flex-col overflow-hidden sm:max-w-3xl">
        <DialogHeader>
          <div className="flex items-center gap-2">
            <Badge variant="outline">{kindLabel}</Badge>
          </div>
          <DialogTitle className="pr-6 text-left">{title}</DialogTitle>
          {detail && (
            <DialogDescription className="whitespace-pre-wrap text-left text-sm text-foreground/80">
              {detail}
            </DialogDescription>
          )}
        </DialogHeader>

        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto">
          {checklist && checklist.length > 0 && <ChecklistSection changes={checklist} />}
          {relations && <RelationsSection relations={relations} />}
          {schedule && <ScheduleSection schedule={schedule} />}
          {calendar && calendar.length > 0 && <CalendarSection events={calendar} />}
          {evidence && evidence.length > 0 && <EvidenceSection notes={evidence} />}
          {pendingProposals && pendingProposals.length > 0 && (
            <section className="rounded-lg border border-amber-300 p-3 text-sm dark:border-amber-800">
              <p className="mb-1 text-xs font-medium uppercase text-muted-foreground">awaiting your review</p>
              {pendingProposals.map(p => (
                <p key={p.id} className="text-muted-foreground">
                  {p.kind}: {p.title}
                </p>
              ))}
            </section>
          )}

          {/* extraction explorer: rant-source links on the left, the active
              rant's extractions beside them */}
          <div className="grid min-h-0 grid-cols-1 gap-3 sm:grid-cols-3">
            <div className="flex flex-col gap-1">
              <p className="text-xs font-medium uppercase text-muted-foreground">rant sources</p>
              {sources.map(s => (
                <button
                  key={s.conversationId}
                  className={cn(
                    "rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted",
                    active?.conversationId === s.conversationId && "bg-muted font-medium",
                  )}
                  onClick={() => setActiveSource(s.conversationId)}
                >
                  <span className="block truncate">{s.title}</span>
                  <span className="text-xs text-muted-foreground">
                    {s.date} · {s.extractions.length} extraction{s.extractions.length === 1 ? "" : "s"}
                  </span>
                </button>
              ))}
              {sources.length === 0 && (
                <p className="px-2 py-1.5 text-sm text-muted-foreground">no citations recorded</p>
              )}
              {revision && (
                <Button variant="ghost" size="sm" className="justify-start" onClick={() => setAdding(a => !a)}>
                  <Plus className="size-3" /> add a rant source
                </Button>
              )}
            </div>

            <div className="flex flex-col gap-2 sm:col-span-2">
              {adding && revision ? (
                <AddRantSource
                  proposalId={revision.proposalId}
                  onDone={() => {
                    setAdding(false);
                    revision.onRevised();
                  }}
                />
              ) : active ? (
                <>
                  {active.extractions.map(x => (
                    <div key={x.id} className="rounded-lg border p-2">
                      <Badge variant="outline" className="mb-1">
                        {EXTRACTION_KIND_LABELS[x.kind] ?? x.kind}
                      </Badge>
                      <p className="flex gap-2 text-sm">
                        <Quote className="mt-1 size-3 shrink-0 text-muted-foreground" />
                        {x.text}
                      </p>
                    </div>
                  ))}
                  {onOpenConversation && (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="mt-1 w-fit"
                      onClick={() => onOpenConversation(active.conversationId)}
                    >
                      <MessageSquareText className="size-3.5" /> open full source conversation
                    </Button>
                  )}
                </>
              ) : (
                <p className="rounded-lg border border-dashed px-3 py-6 text-center text-sm text-muted-foreground">
                  this item has no extraction citations
                </p>
              )}
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// The scoped-out steps: what each change constitutes, the smallest version
// that counts, and why it matters — the experiment as detailed steps.
function ChecklistSection({ changes }: { changes: ProposedChange[] }) {
  const KIND_LABEL: Record<ProposedChange["kind"], string> = {
    habit_change: "habit change",
    experience: "experience to gain",
    environment_change: "environment change",
  };
  return (
    <section className="flex flex-col gap-2">
      <p className="text-xs font-medium uppercase text-muted-foreground">the changes, scoped out</p>
      {changes.map((c, i) => (
        <div key={i} className="flex flex-col gap-1.5 rounded-lg border p-3">
          <div className="flex items-center gap-2">
            <Badge variant="outline">{KIND_LABEL[c.kind]}</Badge>
            <span className="text-sm font-medium">{c.title}</span>
          </div>
          <p className="text-sm">{c.detail}</p>
          <p className="text-sm text-muted-foreground">
            <span className="font-medium">smaller still counts:</span> {c.easier}
          </p>
          <p className="text-sm italic text-muted-foreground">
            <span className="font-medium not-italic">why it matters:</span> {c.why}
          </p>
        </div>
      ))}
    </section>
  );
}

const STATUS_CHIP: Record<string, string> = {
  active: "bg-emerald-100 dark:bg-emerald-950",
  running: "bg-orange-100 dark:bg-orange-950",
  building: "bg-orange-100 dark:bg-orange-950",
  queued: "bg-muted",
  scheduling: "bg-orange-100 dark:bg-orange-950",
  established: "bg-emerald-100 dark:bg-emerald-950",
  succeeded: "bg-emerald-200 dark:bg-emerald-900",
  failed: "bg-muted",
  lapsed: "bg-muted",
  backlog: "bg-muted",
  dormant: "bg-muted",
};

function chip(label: string, status: string, key: string) {
  return (
    <span key={key} className={cn("rounded-full px-2.5 py-1 text-xs", STATUS_CHIP[status] ?? "bg-muted")}>
      {label} <span className="opacity-60">· {status}</span>
    </span>
  );
}

// Every relation the data model holds, rendered only when present.
function RelationsSection({ relations }: { relations: Relations }) {
  const rows: { label: string; content: ReactNode }[] = [];
  if (relations.goals?.length) {
    rows.push({
      label: "the goals this serves",
      content: <div className="flex flex-wrap gap-1.5">{relations.goals.map(g => chip(g.title, g.status, g.id))}</div>,
    });
  }
  if (relations.experiments?.length) {
    rows.push({
      label: "attempts on this goal",
      content: (
        <div className="flex flex-col gap-1.5">
          {relations.experiments.map(e => (
            <div key={e.id} className="rounded-lg border p-2 text-sm">
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium">{e.title}</span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {e.status}
                  {e.endedAt ? ` · ${e.endedAt.slice(0, 10)}` : e.startedAt ? ` · since ${e.startedAt.slice(0, 10)}` : ""}
                </span>
              </div>
              {e.outcomeMd && <p className="mt-1 text-xs text-muted-foreground">{e.outcomeMd}</p>}
            </div>
          ))}
        </div>
      ),
    });
  }
  if (relations.habits?.length) {
    rows.push({
      label: "habits",
      content: <div className="flex flex-wrap gap-1.5">{relations.habits.map(h => chip(h.title, h.status, h.id))}</div>,
    });
  }
  if (relations.environment?.length) {
    rows.push({
      label: "environment",
      content: (
        <div className="flex flex-wrap gap-1.5">{relations.environment.map(e => chip(e.title, e.status, e.id))}</div>
      ),
    });
  }
  if (relations.experiences?.length) {
    rows.push({
      label: "experiences",
      content: (
        <div className="flex flex-wrap gap-1.5">{relations.experiences.map(e => chip(e.title, e.status, e.id))}</div>
      ),
    });
  }
  if (relations.sources?.length) {
    rows.push({
      label: "linked raw context",
      content: (
        <div className="flex flex-wrap gap-1.5">
          {relations.sources.map(source =>
            source.onOpen ? (
              <button
                key={source.id}
                type="button"
                onClick={source.onOpen}
                className="rounded-full text-left outline-offset-2 hover:opacity-75 focus-visible:outline"
                title={`open ${source.title}`}
              >
                {chip(source.title, source.status, source.id)}
              </button>
            ) : (
              chip(source.title, source.status, source.id)
            ),
          )}
        </div>
      ),
    });
  }
  if (!rows.length) return null;
  return (
    <section className="flex flex-col gap-3">
      {rows.map(r => (
        <div key={r.label} className="flex flex-col gap-1.5">
          <p className="text-xs font-medium uppercase text-muted-foreground">{r.label}</p>
          {r.content}
        </div>
      ))}
    </section>
  );
}

function describeRrule(rrule: string | null): string {
  if (!rrule) return "one-time";
  return rrule
    .replace("FREQ=", "")
    .replace("BYDAY=", "")
    .toLowerCase()
    .split(";")
    .join(" ");
}

// When this shows up in the week: live calendar blocks, needs_reschedule flagged.
function CalendarSection({ events }: { events: CalendarEventRow[] }) {
  return (
    <section className="flex flex-col gap-1.5">
      <p className="text-xs font-medium uppercase text-muted-foreground">on the calendar</p>
      {events.map(e => (
        <div key={e.id} className="flex items-center justify-between gap-2 rounded-lg border px-3 py-1.5 text-sm">
          <span className="min-w-0 truncate">{e.title}</span>
          <span className="shrink-0 text-xs text-muted-foreground">
            {describeRrule(e.rrule)} · {e.startAt.slice(11, 16)}
            {e.status === "needs_reschedule" && (
              <Badge variant="outline" className="ml-1">
                waiting for a better day
              </Badge>
            )}
          </span>
        </div>
      ))}
    </section>
  );
}

// The dated notes trail: denials, outcomes, volunteered commentary.
function EvidenceSection({ notes }: { notes: EvidenceNote[] }) {
  return (
    <section className="flex flex-col gap-1.5">
      <p className="text-xs font-medium uppercase text-muted-foreground">evidence notes</p>
      {notes.map(n => (
        <p key={n.id} className="text-sm text-muted-foreground">
          <span className="font-mono text-xs">{n.createdAt.slice(0, 10)}</span> — {n.note}
          {n.conversationTitle && <span className="text-xs"> ({n.conversationTitle})</span>}
        </p>
      ))}
    </section>
  );
}

function ScheduleSection({ schedule }: { schedule: ScheduleInfo }) {
  return (
    <section className="flex flex-col gap-2 rounded-lg border p-3">
      <div className="flex flex-wrap gap-2">
        {schedule.startedAt && <Badge variant="outline">started {schedule.startedAt.slice(0, 10)}</Badge>}
        {schedule.plannedDurationDays != null && (
          <Badge variant="outline">~{schedule.plannedDurationDays} days</Badge>
        )}
        {schedule.bandwidth && <Badge variant="outline">bandwidth: {schedule.bandwidth}</Badge>}
      </div>
      {schedule.tasks && schedule.tasks.length > 0 && (
        <ul className="flex flex-col gap-1 text-sm">
          {schedule.tasks.map(t => (
            <li key={t.id} className="flex items-baseline justify-between gap-2">
              <span className={cn(t.status === "done" && "text-muted-foreground line-through")}>{t.title}</span>
              <span className="shrink-0 text-xs text-muted-foreground">
                {t.kind}
                {t.scheduledFor ? ` · ${t.scheduledFor.slice(5, 16).replace("T", " ")}` : ""} · {t.status}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// "This was also referenced in that chat": pick a reviewed rant, say why, and
// the backend agent re-grounds the proposal on the fuller evidence.
function AddRantSource({ proposalId, onDone }: { proposalId: string; onDone: () => void }) {
  const [q, setQ] = useState("");
  const { data: conversations } = useApiData(() => api.conversations({ q: q || undefined }), [q]);
  const [selected, setSelected] = useState<string | null>(null);
  const [instruction, setInstruction] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const send = async () => {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      await api.reviseProposal(proposalId, selected, instruction.trim() || undefined);
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-emerald-500 p-3">
      <p className="text-sm font-medium">where else did you talk about this?</p>
      <Input placeholder="search rants…" value={q} onChange={e => setQ(e.target.value)} />
      <div className="flex max-h-36 flex-col gap-1 overflow-y-auto">
        {(conversations ?? []).map(c => {
          const reviewed = c.extractionsReviewedAt !== null;
          return (
            <button
              key={c.id}
              disabled={!reviewed}
              className={cn(
                "rounded px-2 py-1 text-left text-sm",
                reviewed ? "hover:bg-muted" : "cursor-not-allowed opacity-50",
                selected === c.id && "bg-muted font-medium",
              )}
              onClick={() => setSelected(c.id)}
            >
              <span className="block truncate">{c.title ?? "(untitled)"}</span>
              <span className="text-xs text-muted-foreground">
                {(c.sourceUpdatedAt ?? "").slice(0, 10)}
                {!reviewed && " · needs read-back first"}
              </span>
            </button>
          );
        })}
      </div>
      <Textarea
        placeholder="why is that rant relevant here? (goes to the reviser agent)"
        value={instruction}
        onChange={e => setInstruction(e.target.value)}
      />
      <Button size="sm" disabled={!selected || busy} onClick={send}>
        {busy ? <Loader2 className="size-3 animate-spin" /> : <Send className="size-3" />}
        {busy ? "revising with the fuller evidence…" : "revise this proposal"}
      </Button>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
