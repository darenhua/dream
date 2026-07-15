import { useState } from "react";
import { Check, ChevronLeft, ChevronRight, Loader2, MessagesSquare, ScanSearch, X } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { api, type ConversationRow } from "@/lib/api";
import { useApiData } from "@/lib/useApiData";
import { cn } from "@/lib/utils";

// The rant explorer: the safe on-ramp for a bulk conversations.json import.
// Nothing classifies until a button here says so (turn AUTO_DETECT off before
// a big import) — browse the whole backlog, classify at your own pace, read
// any thread, and admit rants into the pipeline one decision at a time.

type FilterKey = "all" | "undetected" | "proposed" | "accepted" | "rejected" | "not_candidate";

const FILTERS: { key: FilterKey; label: string; params: Record<string, string> }[] = [
  { key: "all", label: "all", params: {} },
  { key: "undetected", label: "unclassified", params: { detected: "false" } },
  { key: "proposed", label: "candidates", params: { rant: "proposed" } },
  { key: "accepted", label: "accepted", params: { rant: "accepted" } },
  { key: "rejected", label: "rejected", params: { rant: "rejected" } },
  { key: "not_candidate", label: "not rants", params: { verdict: "not_candidate" } },
];

const VERDICT_STYLE: Record<string, string> = {
  candidate: "bg-violet-200 text-violet-900 dark:bg-violet-900 dark:text-violet-100",
  not_candidate: "bg-muted text-muted-foreground",
};

export function RantExplorer({ onOpenSteer }: { onOpenSteer: (sessionId: string) => void }) {
  const [filter, setFilter] = useState<FilterKey>("all");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [tick, setTick] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  const params = FILTERS.find(f => f.key === filter)!.params;
  const { data } = useApiData(
    () => api.conversationsPaged({ page, pageSize: 25, q: search || undefined, ...params }),
    [page, filter, search, tick],
  );
  const bump = () => setTick(t => t + 1);
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  const act = async (key: string, fn: () => Promise<unknown>, label?: string) => {
    setBusy(key);
    setMessage(null);
    try {
      const result = await fn();
      if (label) setMessage(`${label}: ${JSON.stringify(result).slice(0, 160)}`);
      bump();
    } catch (e) {
      setMessage(`${key} failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-wrap items-center gap-2">
        <h2 className="mr-2 text-lg font-semibold">rant explorer</h2>
        <Button
          size="sm"
          variant="outline"
          disabled={busy !== null}
          onClick={() => act("classify", () => api.runDetectLimited(25), "classified")}
        >
          {busy === "classify" ? <Loader2 className="animate-spin" /> : <ScanSearch className="size-3" />}
          classify next 25 unclassified
        </Button>
      </header>

      <div className="flex flex-wrap items-center gap-2">
        {FILTERS.map(f => (
          <Button
            key={f.key}
            size="sm"
            variant={filter === f.key ? "secondary" : "ghost"}
            onClick={() => {
              setFilter(f.key);
              setPage(1);
            }}
          >
            {f.label}
          </Button>
        ))}
        <Input
          placeholder="search titles…"
          value={search}
          onChange={e => {
            setSearch(e.target.value);
            setPage(1);
          }}
          className="w-48"
        />
        <span className="text-xs text-muted-foreground">{data ? `${data.total} conversations` : "…"}</span>
      </div>

      {message && <p className="rounded-lg border border-dashed px-3 py-2 font-mono text-xs text-muted-foreground">{message}</p>}

      <Card>
        <CardContent className="flex flex-col gap-1 px-3 py-2">
          {(data?.conversations ?? []).map(c => (
            <div
              key={c.id}
              className="flex flex-col gap-1 rounded-lg border-b px-2 py-2 last:border-b-0 sm:flex-row sm:items-center sm:gap-2"
            >
              <button className="flex min-w-0 flex-1 items-center gap-2 text-left" onClick={() => setOpenId(c.id)}>
                <span className="shrink-0 font-mono text-xs text-muted-foreground">
                  {(c.sourceUpdatedAt ?? c.createdAt).slice(0, 10)}
                </span>
                <span className="min-w-0 truncate text-sm hover:underline">{c.title ?? "(untitled)"}</span>
                <span className="shrink-0 text-xs text-muted-foreground">{c.messageCount ?? "?"} msgs</span>
              </button>
              <div className="flex shrink-0 flex-wrap items-center gap-1">
                {c.rantVerdict === null && !c.rantStatus ? (
                  <Badge variant="outline">unclassified</Badge>
                ) : (
                  <Badge className={cn("border-transparent", VERDICT_STYLE[c.rantVerdict ?? ""])}>
                    {/* a human decision always outranks the detector's verdict */}
                    {c.rantStatus === "accepted" || c.rantStatus === "rejected"
                      ? c.rantStatus
                      : c.rantVerdict === "not_candidate"
                        ? "not a rant"
                        : (c.rantStatus ?? c.rantVerdict)}
                  </Badge>
                )}
                {(c.rantStatus === "accepted" || c.distilledAt) && (
                  <Badge variant="outline">{c.pipelineState.replaceAll("_", " ")}</Badge>
                )}
                {c.rantVerdict === null && !c.rantStatus && (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy === c.id}
                    onClick={() => act(c.id, () => api.detectConversation(c.id))}
                  >
                    {busy === c.id ? <Loader2 className="animate-spin" /> : <ScanSearch className="size-3" />} classify
                  </Button>
                )}
                {c.rantStatus !== "accepted" && c.rantStatus !== "rejected" && (
                  <>
                    <Button size="sm" variant="ghost" disabled={busy === c.id} onClick={() => act(c.id, () => api.rantAccept(c.id))}>
                      <Check className="size-3" /> accept
                    </Button>
                    <Button size="sm" variant="ghost" disabled={busy === c.id} onClick={() => act(c.id, () => api.rantReject(c.id))}>
                      <X className="size-3" />
                    </Button>
                  </>
                )}
              </div>
            </div>
          ))}
          {data && data.conversations.length === 0 && (
            <p className="px-2 py-6 text-center text-sm text-muted-foreground">nothing matches this filter</p>
          )}
        </CardContent>
      </Card>

      <div className="flex items-center justify-center gap-3 text-sm">
        <Button size="sm" variant="ghost" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>
          <ChevronLeft className="size-4" />
        </Button>
        <span className="text-muted-foreground">
          page {page} / {pages}
        </span>
        <Button size="sm" variant="ghost" disabled={page >= pages} onClick={() => setPage(p => p + 1)}>
          <ChevronRight className="size-4" />
        </Button>
      </div>

      {openId && (
        <ThreadDialog
          conversationId={openId}
          onClose={() => setOpenId(null)}
          onChanged={bump}
          onOpenSteer={onOpenSteer}
        />
      )}
    </div>
  );
}

function ThreadDialog({
  conversationId,
  onClose,
  onChanged,
  onOpenSteer,
}: {
  conversationId: string;
  onClose: () => void;
  onChanged: () => void;
  onOpenSteer: (sessionId: string) => void;
}) {
  const { data: convo } = useApiData(() => api.conversation(conversationId), [conversationId]);
  const [busy, setBusy] = useState<string | null>(null);

  const act = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    try {
      await fn();
      onChanged();
    } finally {
      setBusy(null);
    }
  };

  return (
    <Dialog open onOpenChange={open => !open && onClose()}>
      <DialogContent className="flex max-h-[85vh] max-w-3xl flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle className="pr-8 text-base">{convo?.title ?? "…"}</DialogTitle>
        </DialogHeader>
        {convo && (
          <>
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
              <span>source: {convo.source}</span>
              <span>created: {(convo.sourceCreatedAt ?? "").slice(0, 16).replace("T", " ")}</span>
              <span>updated: {(convo.sourceUpdatedAt ?? "").slice(0, 16).replace("T", " ")}</span>
              <span>msgs: {convo.messages?.length ?? 0}</span>
              <span>state: {convo.pipelineState.replaceAll("_", " ")}</span>
              {convo.detectorNote && <span className="w-full">detector: {convo.detectorNote}</span>}
            </div>

            <div className="flex flex-wrap gap-1">
              {convo.rantVerdict === null && !convo.rantStatus && (
                <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => act("classify", () => api.detectConversation(convo.id))}>
                  {busy === "classify" ? <Loader2 className="animate-spin" /> : <ScanSearch className="size-3" />} classify
                </Button>
              )}
              {convo.rantStatus !== "accepted" && convo.rantStatus !== "rejected" && (
                <>
                  <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => act("accept", () => api.rantAccept(convo.id))}>
                    <Check className="size-3" /> accept as rant
                  </Button>
                  <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => act("reject", () => api.rantReject(convo.id))}>
                    <X className="size-3" /> reject
                  </Button>
                </>
              )}
              {convo.distilledAt && !convo.extractionsReviewedAt && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy !== null}
                  onClick={() =>
                    act("steer", async () => {
                      const { sessionId } = await api.startSteer("distill", convo.id);
                      onClose();
                      onOpenSteer(sessionId);
                    })
                  }
                >
                  <MessagesSquare className="size-3" /> steer the extraction pass
                </Button>
              )}
            </div>

            {convo.extractions.length > 0 && (
              <div className="rounded-lg border border-dashed px-3 py-2 text-xs">
                <p className="mb-1 font-medium uppercase text-muted-foreground">extractions</p>
                {convo.extractions.map(x => (
                  <p key={x.id} className="truncate">
                    <span className="text-muted-foreground">{x.kind}:</span> {x.text}
                  </p>
                ))}
              </div>
            )}

            <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto rounded-lg border p-3">
              {(convo.messages ?? []).map((m, i) => (
                <div
                  key={i}
                  className={cn(
                    "max-w-[90%] whitespace-pre-wrap rounded-xl px-3 py-2 text-sm",
                    m.role === "user" ? "self-end bg-primary text-primary-foreground" : "self-start bg-muted",
                  )}
                >
                  {m.content}
                </div>
              ))}
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
