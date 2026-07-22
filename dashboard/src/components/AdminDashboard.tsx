import { useRef, useState } from "react";
import { Loader2, Play, Upload } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import { useApiData } from "@/lib/useApiData";
import { cn } from "@/lib/utils";
import { AnchorConfig } from "./admin/AnchorConfig";
import { CalendarPanel } from "./admin/CalendarPanel";
import { DangerZone } from "./admin/DangerZone";
import { EventsFeed } from "./admin/EventsFeed";
import { HistoryPanel } from "./admin/HistoryPanel";
import { QuickAdd } from "./admin/QuickAdd";
import { StrikesSection } from "./admin/StrikesSection";

export function AdminDashboard({ onChanged }: { onChanged: () => void | Promise<void> }) {
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
          {running === "daily" ? <Loader2 className="animate-spin" /> : <Play />} run heartbeat now
          <span className="text-muted-foreground">(strikes → pings → calendar)</span>
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

      <ConversationBrowser refreshKey={refreshTick} />
      <CalendarPanel refreshKey={refreshTick} />
      <StrikesSection refreshKey={refreshTick} onChanged={handleChanged} />
      <AnchorConfig onChanged={handleChanged} />
      <QuickAdd onChanged={handleChanged} />
      <EventsFeed refreshKey={refreshTick} />
      <HistoryPanel refreshKey={refreshTick} />
      <DangerZone onChanged={handleChanged} />

      <ImportDialog open={importOpen} onOpenChange={setImportOpen} onImported={handleChanged} />
    </div>
  );
}

// Plain imported-conversation browser; the pipeline FSM is gone.
function ConversationBrowser({ refreshKey }: { refreshKey: number }) {
  const [search, setSearch] = useState("");
  const { data: conversations } = useApiData(() => api.conversations(), [refreshKey]);

  const visible = (conversations ?? []).filter(c =>
    (c.title ?? "").toLowerCase().includes(search.toLowerCase()),
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base font-medium">imported conversations</CardTitle>
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
            <li key={c.id} className="flex items-center gap-2 rounded-lg border px-3 py-2 text-sm">
              <span className="font-mono text-xs text-muted-foreground">
                {(c.sourceUpdatedAt ?? "").slice(0, 10)}
              </span>
              <span className="min-w-0 flex-1 truncate">{c.title ?? "(untitled)"}</span>
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

  const handleFile = async (file: File) => {
    setError(null);
    setReport(null);
    setBusy(true);
    try {
      const result = await api.importFile(file);
      setReport(
        `imported: ${result.new} new · ${result.updated} updated · ${result.unchanged} unchanged` +
          (result.errors.length ? ` · ${result.errors.length} errors` : ""),
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
