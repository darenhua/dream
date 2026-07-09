import { useRef, useState } from "react";
import { Loader2, Play, Upload } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { api, type ConversationRow, type PipelineState } from "@/lib/api";
import { useApiData } from "@/lib/useApiData";
import { cn } from "@/lib/utils";
import { AnchorConfig } from "./admin/AnchorConfig";
import { CalendarPanel } from "./admin/CalendarPanel";
import { DangerZone } from "./admin/DangerZone";
import { EventsFeed } from "./admin/EventsFeed";
import { HistoryPanel } from "./admin/HistoryPanel";
import { ProposalLedger } from "./admin/ProposalLedger";
import { QuickAdd } from "./admin/QuickAdd";

const STATE_STYLE: Record<PipelineState, string> = {
  parse_failed: "bg-red-200 text-red-900 dark:bg-red-900 dark:text-red-100",
  idle: "bg-muted text-muted-foreground",
  awaiting_distill: "bg-amber-200 text-amber-900 dark:bg-amber-900 dark:text-amber-100",
  awaiting_review: "bg-emerald-200 text-emerald-900 dark:bg-emerald-900 dark:text-emerald-100",
  awaiting_derive: "bg-sky-200 text-sky-900 dark:bg-sky-900 dark:text-sky-100",
  derived: "bg-green-200 text-green-900 dark:bg-green-900 dark:text-green-100",
};

export function AdminDashboard({
  onChanged,
  onReviewExtractions,
}: {
  onChanged: () => void | Promise<void>;
  onReviewExtractions: (conversationId: string) => void;
}) {
  const [refreshTick, setRefreshTick] = useState(0);
  const [importOpen, setImportOpen] = useState(false);
  const [running, setRunning] = useState<string | null>(null);
  const [jobResult, setJobResult] = useState<string | null>(null);

  const handleChanged = async () => {
    await onChanged();
    setRefreshTick(t => t + 1);
  };

  const runJob = async (name: string, job: () => Promise<unknown>) => {
    setRunning(name);
    setJobResult(null);
    try {
      const result = await job();
      setJobResult(`${name}: ${JSON.stringify(result).slice(0, 240)}`);
      await handleChanged();
    } catch (e) {
      setJobResult(`${name} failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setRunning(null);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Button variant="outline" disabled={running !== null} onClick={() => runJob("daily", api.runDaily)}>
          {running === "daily" ? <Loader2 className="animate-spin" /> : <Play />} run daily now
          <span className="text-muted-foreground">(distill → derive → writeup → sync)</span>
        </Button>
        <Button variant="outline" disabled={running !== null} onClick={() => runJob("distill", api.runDistill)}>
          {running === "distill" && <Loader2 className="animate-spin" />} run distill
        </Button>
        <Button variant="outline" disabled={running !== null} onClick={() => runJob("derive", () => api.runDerive())}>
          {running === "derive" && <Loader2 className="animate-spin" />} run derive (reviewed rants)
        </Button>
        <Button variant="outline" disabled={running !== null} onClick={() => runJob("writeup", api.runWriteup)}>
          {running === "writeup" && <Loader2 className="animate-spin" />} run writeup
        </Button>
        <Button variant="outline" onClick={() => setImportOpen(true)}>
          <Upload /> import conversations.json
        </Button>
      </div>

      {jobResult && (
        <p className="rounded-lg border border-dashed px-3 py-2 font-mono text-xs text-muted-foreground">
          {jobResult}
        </p>
      )}

      <PipelineBrowser
        refreshKey={refreshTick}
        onChanged={handleChanged}
        onReviewExtractions={onReviewExtractions}
      />
      <CalendarPanel refreshKey={refreshTick} />
      <AnchorConfig onChanged={handleChanged} />
      <QuickAdd onChanged={handleChanged} />
      <ProposalLedger refreshKey={refreshTick} />
      <EventsFeed refreshKey={refreshTick} />
      <HistoryPanel refreshKey={refreshTick} />
      <DangerZone onChanged={handleChanged} />

      <ImportDialog open={importOpen} onOpenChange={setImportOpen} onImported={handleChanged} />
    </div>
  );
}

// The conversation pipeline browser: every rant with its FSM state and the
// stage-appropriate action.
function PipelineBrowser({
  refreshKey,
  onChanged,
  onReviewExtractions,
}: {
  refreshKey: number;
  onChanged: () => Promise<void>;
  onReviewExtractions: (conversationId: string) => void;
}) {
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const { data: conversations } = useApiData(() => api.conversations(), [refreshKey]);

  const visible = (conversations ?? []).filter(c =>
    (c.title ?? "").toLowerCase().includes(search.toLowerCase()),
  );

  const act = async (id: string, fn: () => Promise<unknown>) => {
    setBusy(id);
    try {
      await fn();
      await onChanged();
    } finally {
      setBusy(null);
    }
  };

  const actionFor = (c: ConversationRow) => {
    switch (c.pipelineState) {
      case "idle":
        return (
          <Button size="sm" variant="outline" disabled={busy === c.id} onClick={() => act(c.id, () => api.requestDistill(c.id))}>
            distill this
          </Button>
        );
      case "awaiting_review":
        return (
          <Button size="sm" variant="outline" onClick={() => onReviewExtractions(c.id)}>
            review
          </Button>
        );
      case "awaiting_derive":
        return (
          <Button size="sm" variant="outline" disabled={busy === c.id} onClick={() => act(c.id, () => api.runDerive(c.id))}>
            derive now
          </Button>
        );
      case "derived":
        return (
          <div className="flex gap-1">
            <Button size="sm" variant="ghost" disabled={busy === c.id} onClick={() => act(c.id, () => api.rederive(c.id))}>
              re-derive
            </Button>
            <Button size="sm" variant="ghost" disabled={busy === c.id} onClick={() => act(c.id, () => api.redistill(c.id))}>
              re-distill
            </Button>
          </div>
        );
      default:
        return null;
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base font-medium">pipeline browser</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <Input
          placeholder="search…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="sm:max-w-xs"
        />
        <ul className="flex max-h-96 flex-col gap-2 overflow-y-auto">
          {visible.map(c => (
            <li key={c.id} className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <div className={cn("flex flex-1 items-center gap-2 rounded-lg border px-3 py-2 text-sm")}>
                <span className="font-mono text-xs text-muted-foreground">
                  {(c.sourceUpdatedAt ?? "").slice(0, 10)}
                </span>
                <span className="min-w-0 flex-1 truncate">{c.title ?? "(untitled)"}</span>
                {c.slugDetected && <span title="marker slug present">✓</span>}
                <Badge className={cn("border-transparent", STATE_STYLE[c.pipelineState])}>
                  {c.pipelineState.replace("_", " ")}
                </Badge>
              </div>
              {actionFor(c)}
            </li>
          ))}
          {visible.length === 0 && (
            <li className="rounded-lg border border-dashed px-3 py-2 text-center text-sm text-muted-foreground">
              No conversations — import your export file.
            </li>
          )}
        </ul>
      </CardContent>
    </Card>
  );
}

function ImportDialog({
  open,
  onOpenChange,
  onImported,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onImported: () => void | Promise<void>;
}) {
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // The raw Claude conversations.json goes straight to the backend; slugged
  // rants start distilling immediately.
  const handleFile = async (file: File) => {
    setError(null);
    setReport(null);
    setBusy(true);
    try {
      const result = await api.importFile(file);
      setReport(
        `imported: ${result.new} new · ${result.updated} updated · ${result.unchanged} unchanged` +
          (result.errors.length ? ` · ${result.errors.length} errors` : "") +
          " — distilling in the background",
      );
      await onImported();
    } catch (e) {
      setError(e instanceof Error ? e.message : "import failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={o => {
        setError(null);
        setReport(null);
        setDragOver(false);
        onOpenChange(o);
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-center text-xl">import</DialogTitle>
        </DialogHeader>
        <button
          type="button"
          className={cn(
            "flex min-h-56 cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed p-6 text-muted-foreground transition-colors",
            dragOver && "border-foreground bg-accent text-foreground",
          )}
          onClick={() => fileInputRef.current?.click()}
          onDragOver={e => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={e => {
            e.preventDefault();
            setDragOver(false);
            const file = e.dataTransfer.files[0];
            if (file) handleFile(file);
          }}
        >
          {busy ? <Loader2 className="size-6 animate-spin" /> : <Upload className="size-6" />}
          <span className="text-lg">
            drop
            <br />
            conversations.json
          </span>
        </button>
        {report && <p className="text-center text-sm">{report}</p>}
        {error && <p className="text-center text-sm text-destructive">{error}</p>}
        <input
          ref={fileInputRef}
          type="file"
          accept="application/json,.json"
          className="hidden"
          onChange={e => {
            const file = e.target.files?.[0];
            if (file) handleFile(file);
            e.target.value = "";
          }}
        />
      </DialogContent>
    </Dialog>
  );
}
