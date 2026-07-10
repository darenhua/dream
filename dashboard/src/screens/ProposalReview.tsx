import { useState } from "react";
import { ArrowLeft, Check, X } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { api, type ProposalRow } from "@/lib/api";
import { useApiData } from "@/lib/useApiData";
import { DetailModal } from "../components/DetailModal";
import { PROPOSAL_KIND_LABELS } from "../data";

// Human gate #2 — "do I accept?": compact rows; clicking one opens the shared
// detail modal (extraction explorer + revision surface).
const GROUPS: { title: string; kinds: string[] }[] = [
  { title: "experiment candidates", kinds: ["experiment_propose"] },
  { title: "goals", kinds: ["goal_create", "goal_update", "synthesis_update"] },
  { title: "habits", kinds: ["habit_add", "habit_update"] },
  { title: "environment", kinds: ["environment_add", "environment_update"] },
  { title: "experiences", kinds: ["experience_add"] },
];

export function summarize(p: ProposalRow): { title: string; detail: string | null } {
  const pl = p.payload;
  switch (p.kind) {
    case "goal_create":
      return { title: pl.title, detail: pl.identity_clause ?? null };
    case "goal_update":
      return { title: pl.title ?? "update goal", detail: pl.reason ?? null };
    case "synthesis_update":
      return { title: "updated understanding", detail: pl.reason ?? null };
    case "habit_add":
      return { title: pl.title, detail: pl.note ?? "a habit you already have" };
    case "habit_update":
      return {
        title: pl.status ? `habit → ${pl.status}` : (pl.title ?? "update habit"),
        detail: pl.reason ?? null,
      };
    case "environment_add":
      return { title: pl.title, detail: pl.note ?? pl.sub_kind };
    case "environment_update":
      return { title: pl.title ?? "update environment", detail: pl.reason ?? null };
    case "experience_add":
      return {
        title: pl.title,
        detail: pl.state === "planned" ? "something you want to have" : "something that happened",
      };
    case "experiment_propose":
      return { title: pl.title, detail: pl.hypothesis_md ?? null };
    default:
      return { title: p.kind, detail: null };
  }
}

export function ProposalReview({ onChanged, onBack }: { onChanged: () => void; onBack: () => void }) {
  const [tick, setTick] = useState(0);
  const { data: proposals } = useApiData(() => api.proposals(), [tick]);
  const rows = proposals ?? [];
  const [openId, setOpenId] = useState<string | null>(null);
  const bump = () => {
    setTick(t => t + 1);
    onChanged();
  };

  // The modal reads the freshest copy (revisions update it in place).
  const openProposal = rows.find(p => p.id === openId) ?? null;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="sm" onClick={onBack}>
          <ArrowLeft className="size-4" /> back
        </Button>
        <h2 className="font-medium">proposed changes</h2>
        <span className="text-sm text-muted-foreground">approving is never urgent. ignoring is free.</span>
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
          <section key={group.title} className="flex flex-col gap-1.5">
            <h3 className="text-xs font-medium uppercase text-muted-foreground">{group.title}</h3>
            {groupRows.map(p => (
              <ProposalRowView key={p.id} proposal={p} onOpen={() => setOpenId(p.id)} onResolved={bump} />
            ))}
          </section>
        );
      })}

      {openProposal && (
        <DetailModal
          open
          onClose={() => setOpenId(null)}
          kindLabel={PROPOSAL_KIND_LABELS[openProposal.kind] ?? openProposal.kind}
          title={summarize(openProposal).title}
          detail={summarize(openProposal).detail}
          extractions={openProposal.citedExtractions}
          revision={{ proposalId: openProposal.id, onRevised: bump }}
        />
      )}
    </div>
  );
}

function ProposalRowView({
  proposal,
  onOpen,
  onResolved,
}: {
  proposal: ProposalRow;
  onOpen: () => void;
  onResolved: () => void;
}) {
  const [denying, setDenying] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const { title } = summarize(proposal);

  const approve = async () => {
    setBusy(true);
    try {
      await api.approveProposal(proposal.id);
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
    <div className="rounded-lg border">
      <div className="flex items-center gap-2 px-3 py-2">
        <button className="flex min-w-0 flex-1 items-center gap-2 text-left" onClick={onOpen}>
          <Badge variant="outline" className="shrink-0">
            {PROPOSAL_KIND_LABELS[proposal.kind] ?? proposal.kind}
          </Badge>
          <span className="min-w-0 truncate text-sm font-medium">{title}</span>
          <span className="shrink-0 text-xs text-muted-foreground">
            {proposal.citedExtractions.length} citation{proposal.citedExtractions.length === 1 ? "" : "s"}
          </span>
        </button>
        <div className="flex shrink-0 gap-1">
          <Button size="sm" variant="ghost" disabled={busy} onClick={approve} title="approve">
            <Check className="size-3" />
          </Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => setDenying(d => !d)} title="deny">
            <X className="size-3" />
          </Button>
        </div>
      </div>
      {denying && (
        <div className="flex flex-col gap-2 border-t px-3 py-2">
          <Textarea
            placeholder="why not? (optional — becomes evidence)"
            value={note}
            onChange={e => setNote(e.target.value)}
          />
          <Button size="sm" variant="destructive" disabled={busy} onClick={deny} className="self-start">
            deny
          </Button>
        </div>
      )}
    </div>
  );
}
