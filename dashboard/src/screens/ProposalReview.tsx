import { useState } from "react";
import { ArrowLeft, Check, Quote, X } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { api, type ProposalRow } from "@/lib/api";
import { useApiData } from "@/lib/useApiData";
import { PROPOSAL_KIND_LABELS } from "../data";

// Human gate #2 — "do I accept what you suggest?": each card carries the
// user's own curated words (cited extractions) as its justification.
const GROUPS: { title: string; kinds: string[] }[] = [
  { title: "experiment candidates", kinds: ["experiment_propose"] },
  { title: "goals", kinds: ["goal_create", "goal_update", "goal_status", "synthesis_update"] },
  { title: "habits", kinds: ["habit_add", "habit_update", "habit_prune"] },
  { title: "environment", kinds: ["environment_add", "environment_update", "environment_prune"] },
  { title: "experiences", kinds: ["experience_add"] },
];

export function ProposalReview({ onChanged, onBack }: { onChanged: () => void; onBack: () => void }) {
  const [tick, setTick] = useState(0);
  const { data: proposals, refresh } = useApiData(() => api.proposals(), [tick]);
  const rows = proposals ?? [];
  const bump = () => {
    setTick(t => t + 1);
    onChanged();
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="sm" onClick={onBack}>
          <ArrowLeft className="size-4" /> back
        </Button>
        <h2 className="font-medium">proposed changes</h2>
        <span className="text-sm text-muted-foreground">
          approving is never urgent. ignoring is free.
        </span>
      </div>

      {rows.length === 0 && (
        <p className="rounded-lg border border-dashed px-3 py-8 text-center text-sm text-muted-foreground">
          nothing waiting. the queue only fills when you rant.
        </p>
      )}

      {GROUPS.map(group => {
        const groupRows = rows.filter(p => group.kinds.includes(p.kind));
        if (!groupRows.length) return null;
        return (
          <section key={group.title} className="flex flex-col gap-2">
            <h3 className="text-xs font-medium uppercase text-muted-foreground">{group.title}</h3>
            {groupRows.map(p => (
              <ProposalCard key={p.id} proposal={p} onResolved={bump} />
            ))}
          </section>
        );
      })}
    </div>
  );
}

function summarize(p: ProposalRow): { title: string; detail: string | null } {
  const pl = p.payload;
  switch (p.kind) {
    case "goal_create":
      return { title: pl.title, detail: pl.identity_clause ?? null };
    case "goal_update":
      return { title: pl.title ?? "update goal", detail: pl.reason ?? null };
    case "goal_status":
      return { title: `mark goal → ${pl.status}`, detail: pl.reason ?? null };
    case "synthesis_update":
      return { title: "updated understanding", detail: pl.reason ?? null };
    case "habit_add":
      return { title: pl.title, detail: pl.note ?? "a habit you already have" };
    case "habit_update":
      return { title: pl.title ?? "update habit", detail: pl.reason ?? null };
    case "habit_prune":
      return { title: "this habit no longer holds", detail: pl.reason ?? null };
    case "environment_add":
      return { title: pl.title, detail: pl.note ?? pl.sub_kind };
    case "environment_update":
      return { title: pl.title ?? "update environment", detail: pl.reason ?? null };
    case "environment_prune":
      return { title: "environment item gone", detail: pl.reason ?? null };
    case "experience_add":
      return { title: pl.title, detail: pl.state === "planned" ? "something you want to have" : "something that happened" };
    case "experiment_propose":
      return { title: pl.title, detail: pl.hypothesis_md ?? null };
    default:
      return { title: p.kind, detail: null };
  }
}

function ProposalCard({ proposal, onResolved }: { proposal: ProposalRow; onResolved: () => void }) {
  const [denying, setDenying] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [notes, setNotes] = useState<string[]>([]);
  const { title, detail } = summarize(proposal);

  const approve = async () => {
    setBusy(true);
    try {
      const result = await api.approveProposal(proposal.id);
      if (result.notes?.length) setNotes(result.notes);
      onResolved();
    } finally {
      setBusy(false);
    }
  };

  const deny = async () => {
    setBusy(true);
    try {
      await api.denyProposal(proposal.id, note.trim() || undefined);
      onResolved();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <Badge variant="outline">{PROPOSAL_KIND_LABELS[proposal.kind] ?? proposal.kind}</Badge>
            </div>
            <CardTitle className="mt-1 text-base font-medium">{title}</CardTitle>
            {detail && <p className="mt-1 text-sm text-muted-foreground">{detail}</p>}
          </div>
          <div className="flex shrink-0 gap-1">
            <Button size="sm" disabled={busy} onClick={approve}>
              <Check className="size-3" />
            </Button>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => setDenying(d => !d)}>
              <X className="size-3" />
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {proposal.citedExtractions.length > 0 && (
          <div className="flex flex-col gap-1 rounded-lg bg-muted/50 p-2">
            {proposal.citedExtractions.map(x => (
              <p key={x.id} className="flex gap-2 text-sm italic text-muted-foreground">
                <Quote className="mt-0.5 size-3 shrink-0" /> {x.text}
              </p>
            ))}
          </div>
        )}
        {notes.map((n, i) => (
          <p key={i} className="text-xs text-amber-700 dark:text-amber-400">
            {n}
          </p>
        ))}
        {denying && (
          <div className="flex flex-col gap-2">
            <Textarea
              placeholder="why not? (optional — becomes evidence)"
              value={note}
              onChange={e => setNote(e.target.value)}
            />
            <Button size="sm" variant="destructive" disabled={busy} onClick={deny}>
              deny
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
