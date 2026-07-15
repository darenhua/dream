import { useMemo, useState } from "react";
import { ArrowLeft, Check, MessagesSquare, Pencil, Plus, Trash2, X } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { api, type ExtractionKind, type ExtractionRow } from "@/lib/api";
import { useApiData } from "@/lib/useApiData";
import { cn } from "@/lib/utils";
import { EXTRACTION_KIND_LABELS } from "../data";

// Human gate #1 — "did you hear me right?": the transcript beside the
// extractions pinned to their source passages. Curate once, confirm, frozen.
export function ExtractionReview({
  conversationId,
  onDone,
  onOpenSteer,
}: {
  conversationId: string;
  onDone: () => void;
  onOpenSteer: (sessionId: string) => void;
}) {
  const [tick, setTick] = useState(0);
  const bump = () => setTick(t => t + 1);
  const { data: convo } = useApiData(() => api.conversation(conversationId), [conversationId, tick]);
  const [selected, setSelected] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [adding, setAdding] = useState(false);

  const extractions = convo?.extractions ?? [];
  const frozen = extractions.length > 0 && extractions.every(x => x.confirmedAt);
  const selectedExtraction = extractions.find(x => x.id === selected) ?? null;

  // Message indices highlighted by the selected extraction's span.
  const highlight = useMemo(() => {
    if (!selectedExtraction || selectedExtraction.startIdx === null) return new Set<number>();
    const out = new Set<number>();
    for (let i = selectedExtraction.startIdx; i <= (selectedExtraction.endIdx ?? selectedExtraction.startIdx); i++) {
      out.add(i);
    }
    return out;
  }, [selectedExtraction]);

  const confirm = async () => {
    setConfirming(true);
    try {
      await api.confirmExtractions(conversationId);
      onDone();
    } finally {
      setConfirming(false);
    }
  };

  if (!convo) return <p className="py-12 text-center text-sm text-muted-foreground">loading…</p>;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-2">
        <Button variant="ghost" size="sm" onClick={onDone}>
          <ArrowLeft className="size-4" /> back
        </Button>
        <div className="min-w-0 text-center">
          <h2 className="truncate font-medium">{convo.title ?? "(untitled)"}</h2>
          <p className="text-xs text-muted-foreground">
            check two things: did everything you said make it out, and is it your meaning — not a
            paraphrase you wouldn't sign.
          </p>
        </div>
        <div className="flex shrink-0 gap-1">
          {!frozen && (
            <Button
              size="sm"
              variant="outline"
              disabled={confirming}
              title="not quite right? steer the extraction pass in a chat — it redoes the pass your way"
              onClick={async () => {
                const { sessionId } = await api.startSteer("distill", conversationId);
                onOpenSteer(sessionId);
              }}
            >
              <MessagesSquare className="size-4" /> steer
            </Button>
          )}
          <Button size="sm" disabled={frozen || confirming} onClick={confirm}>
            <Check className="size-4" /> {frozen ? "confirmed" : confirming ? "confirming…" : "you heard me right"}
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {/* transcript */}
        <Card className="max-h-[70vh] overflow-y-auto">
          <CardHeader>
            <CardTitle className="text-sm font-medium text-muted-foreground">
              the rant ({(convo.sourceUpdatedAt ?? "").slice(0, 10)})
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ol className="flex flex-col gap-2">
              {(convo.messages ?? []).map((m, i) => (
                <li
                  key={i}
                  className={cn(
                    "max-w-[90%] rounded-lg px-3 py-2 text-sm transition-colors",
                    m.role === "user" ? "self-end bg-primary text-primary-foreground" : "self-start bg-muted",
                    highlight.has(i) && "ring-2 ring-emerald-500",
                  )}
                >
                  {m.content}
                </li>
              ))}
            </ol>
          </CardContent>
        </Card>

        {/* extractions */}
        <Card className="max-h-[70vh] overflow-y-auto">
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                what the system heard ({extractions.length})
              </CardTitle>
              {!frozen && (
                <Button variant="ghost" size="sm" onClick={() => setAdding(true)}>
                  <Plus className="size-3.5" /> it missed something
                </Button>
              )}
            </div>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            {adding && (
              <ExtractionEditor
                initial={{ kind: "goal_talk", text: "" }}
                onCancel={() => setAdding(false)}
                onSave={async (kind, text) => {
                  await api.addExtraction({ conversationId, kind, text });
                  setAdding(false);
                  bump();
                }}
              />
            )}
            {extractions.map(x => (
              <ExtractionPin
                key={x.id}
                extraction={x}
                stale={x.contentHash !== (convo.contentHash ?? x.contentHash)}
                selected={selected === x.id}
                frozen={Boolean(x.confirmedAt)}
                onSelect={() => setSelected(selected === x.id ? null : x.id)}
                onChanged={bump}
              />
            ))}
            {extractions.length === 0 && !adding && (
              <p className="rounded-lg border border-dashed px-3 py-4 text-center text-sm text-muted-foreground">
                the distiller found nothing extractable — add what it missed, or confirm the empty
                set to move on.
              </p>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function ExtractionPin({
  extraction,
  stale,
  selected,
  frozen,
  onSelect,
  onChanged,
}: {
  extraction: ExtractionRow & { contentHash: string };
  stale: boolean;
  selected: boolean;
  frozen: boolean;
  onSelect: () => void;
  onChanged: () => void;
}) {
  const [editing, setEditing] = useState(false);

  if (editing) {
    return (
      <ExtractionEditor
        initial={{ kind: extraction.kind, text: extraction.text }}
        onCancel={() => setEditing(false)}
        onSave={async (kind, text) => {
          await api.patchExtraction(extraction.id, { kind, text });
          setEditing(false);
          onChanged();
        }}
      />
    );
  }

  return (
    <div
      className={cn(
        "cursor-pointer rounded-lg border p-2 transition-colors",
        selected && "border-emerald-500 bg-emerald-50/50 dark:bg-emerald-950/50",
      )}
      onClick={onSelect}
    >
      <div className="mb-1 flex items-center gap-2">
        <Badge variant="outline">{EXTRACTION_KIND_LABELS[extraction.kind] ?? extraction.kind}</Badge>
        {extraction.origin === "manual" && <Badge variant="secondary">added by you</Badge>}
        {stale && (
          <Badge variant="outline" className="text-muted-foreground" title="the conversation changed since this was distilled — the pin no longer points at exact messages, but the words are still yours">
            unpinned
          </Badge>
        )}
        <span className="flex-1" />
        {!frozen && (
          <>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-1"
              onClick={e => {
                e.stopPropagation();
                setEditing(true);
              }}
            >
              <Pencil className="size-3" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-1"
              onClick={async e => {
                e.stopPropagation();
                await api.deleteExtraction(extraction.id);
                onChanged();
              }}
            >
              <Trash2 className="size-3" />
            </Button>
          </>
        )}
      </div>
      <p className="text-sm">{extraction.text}</p>
    </div>
  );
}

function ExtractionEditor({
  initial,
  onSave,
  onCancel,
}: {
  initial: { kind: ExtractionKind; text: string };
  onSave: (kind: ExtractionKind, text: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [kind, setKind] = useState<ExtractionKind>(initial.kind);
  const [text, setText] = useState(initial.text);
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-emerald-500 p-2">
      <Select value={kind} onValueChange={v => setKind(v as ExtractionKind)}>
        <SelectTrigger className="h-8 w-48">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {Object.entries(EXTRACTION_KIND_LABELS).map(([value, label]) => (
            <SelectItem key={value} value={value}>
              {label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Textarea value={text} onChange={e => setText(e.target.value)} placeholder="in your own words…" />
      <div className="flex gap-2">
        <Button size="sm" disabled={!text.trim()} onClick={() => onSave(kind, text.trim())}>
          <Check className="size-3" /> save
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          <X className="size-3" /> cancel
        </Button>
      </div>
    </div>
  );
}
