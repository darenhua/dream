import { useMemo, useState } from "react";
import { Loader2, Plus, Quote, Send } from "lucide-react";

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
import { api, type CitedExtraction, type TaskRow } from "@/lib/api";
import { useApiData } from "@/lib/useApiData";
import { cn } from "@/lib/utils";
import { EXTRACTION_KIND_LABELS } from "../data";

// One modal for proposals AND entities: it takes props and renders whichever
// objects exist — extractions always; schedule objects once approved/committed;
// the revision surface only for pending proposals.

export interface ScheduleInfo {
  tasks?: TaskRow[];
  plannedDurationDays?: number | null;
  startedAt?: string | null;
  bandwidth?: string | null;
}

export interface DetailModalProps {
  open: boolean;
  onClose: () => void;
  kindLabel: string;
  title: string;
  detail?: string | null;
  extractions: CitedExtraction[];
  schedule?: ScheduleInfo;
  revision?: { proposalId: string; onRevised: () => void };
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
  extractions,
  schedule,
  revision,
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
          {detail && <DialogDescription className="text-left">{detail}</DialogDescription>}
        </DialogHeader>

        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto">
          {schedule && <ScheduleSection schedule={schedule} />}

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
                active.extractions.map(x => (
                  <div key={x.id} className="rounded-lg border p-2">
                    <Badge variant="outline" className="mb-1">
                      {EXTRACTION_KIND_LABELS[x.kind] ?? x.kind}
                    </Badge>
                    <p className="flex gap-2 text-sm">
                      <Quote className="mt-1 size-3 shrink-0 text-muted-foreground" />
                      {x.text}
                    </p>
                  </div>
                ))
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
