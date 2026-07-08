import { useEffect, useRef, useState } from "react";
import { ChevronDown, Loader2, Play, Upload } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Toggle } from "@/components/ui/toggle";
import { api, type CategoryRow } from "@/lib/api";
import { cn } from "@/lib/utils";
import { type Conversation } from "../data";
import { CategoriesManager } from "./admin/CategoriesManager";
import { DangerZone } from "./admin/DangerZone";
import { EventsFeed } from "./admin/EventsFeed";
import { HistoryPanel } from "./admin/HistoryPanel";
import { ProposalLedger } from "./admin/ProposalLedger";
import { QuickAdd } from "./admin/QuickAdd";

interface AdminDashboardProps {
  conversations: Conversation[];
  onChanged: () => void | Promise<void>;
}

export function AdminDashboard({ conversations, onChanged }: AdminDashboardProps) {
  const [deriveScope, setDeriveScope] = useState<{ label: string; categoryId?: string }>({
    label: "all",
  });
  const [categories, setCategories] = useState<CategoryRow[]>([]);
  const [search, setSearch] = useState("");
  const [uncategorizedOnly, setUncategorizedOnly] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [running, setRunning] = useState<string | null>(null);
  const [jobResult, setJobResult] = useState<string | null>(null);
  // Bumped after every mutation so the self-fetching panels (ledger, events,
  // history) reload without prop-drilling all their data through App.
  const [refreshTick, setRefreshTick] = useState(0);

  const handleChanged = async () => {
    await onChanged();
    setRefreshTick(t => t + 1);
  };

  useEffect(() => {
    api.categories().then(setCategories).catch(() => setCategories([]));
  }, [conversations]);

  const visible = conversations.filter(c => {
    if (uncategorizedOnly && c.category) return false;
    return c.title.toLowerCase().includes(search.toLowerCase());
  });

  const runJob = async (name: string, job: () => Promise<unknown>) => {
    setRunning(name);
    setJobResult(null);
    try {
      const result = await job();
      setJobResult(`${name}: ${JSON.stringify(result).slice(0, 200)}`);
      await handleChanged();
    } catch (e) {
      setJobResult(`${name} failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setRunning(null);
    }
  };

  const assignCategory = async (convo: Conversation, categoryId: string | null) => {
    if (convo.categoryId) await api.unlinkConversation(convo.id, convo.categoryId);
    if (categoryId) await api.linkConversation(convo.id, categoryId);
    await onChanged();
  };

  const toggleTopK = async (convo: Conversation, pressed: boolean) => {
    if (!convo.linkId) return; // top-K only applies to categorized conversations
    await api.patchLink(convo.linkId, pressed);
    await onChanged();
  };

  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Button
          variant="outline"
          disabled={running !== null}
          onClick={() => runJob("daily", api.runDaily)}
        >
          {running === "daily" ? <Loader2 className="animate-spin" /> : <Play />} run daily now
          <span className="text-muted-foreground">(categorize → derive → writeup)</span>
        </Button>
        <Button
          variant="outline"
          disabled={running !== null}
          onClick={() => runJob("writeup", api.runWriteup)}
        >
          {running === "writeup" && <Loader2 className="animate-spin" />} run writeup
        </Button>
        <Button
          variant="outline"
          disabled={running !== null}
          onClick={() => runJob("categorize", api.runCategorize)}
        >
          {running === "categorize" && <Loader2 className="animate-spin" />} run categorize
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" disabled={running !== null}>
              {running === "derive" && <Loader2 className="animate-spin" />}
              run derive ({deriveScope.label} <ChevronDown />)
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuItem
              onClick={() => {
                setDeriveScope({ label: "all" });
                runJob("derive", () => api.runDerive());
              }}
            >
              all
            </DropdownMenuItem>
            {categories.map(cat => (
              <DropdownMenuItem
                key={cat.id}
                onClick={() => {
                  setDeriveScope({ label: cat.name, categoryId: cat.id });
                  runJob("derive", () => api.runDerive(cat.id));
                }}
              >
                {cat.name}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <Button variant="outline" onClick={() => setImportOpen(true)}>
          import convo json file
        </Button>
      </div>

      {jobResult && (
        <p className="rounded-lg border border-dashed px-3 py-2 font-mono text-xs text-muted-foreground">
          {jobResult}
        </p>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base font-medium">conversations browser</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              placeholder="search..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="sm:max-w-xs"
            />
            <Toggle
              variant="outline"
              pressed={uncategorizedOnly}
              onPressedChange={setUncategorizedOnly}
            >
              uncategorized
            </Toggle>
          </div>

          <ul className="flex flex-col gap-2">
            {visible.map(c => (
              <li key={c.id} className="flex flex-col gap-2 sm:flex-row sm:items-center">
                <div
                  className={cn(
                    "flex-1 rounded-lg border px-3 py-2 text-sm",
                    c.category
                      ? "border-green-300 bg-green-200/70 dark:border-green-800 dark:bg-green-900/40"
                      : "bg-card",
                  )}
                >
                  {c.date} · {c.title}
                  {c.slug && " · slug ✓"}
                  {" · "}
                  {c.category ? `→ ${c.category}` : "uncategorized"}
                </div>
                <div className="flex gap-2">
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="outline" size="sm">
                        assign category
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent>
                      {categories.map(cat => (
                        <DropdownMenuItem key={cat.id} onClick={() => assignCategory(c, cat.id)}>
                          {cat.name}
                        </DropdownMenuItem>
                      ))}
                      <DropdownMenuItem onClick={() => assignCategory(c, null)}>
                        uncategorized
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                  <Toggle
                    variant="outline"
                    size="sm"
                    pressed={c.topK}
                    disabled={!c.linkId}
                    onPressedChange={pressed => toggleTopK(c, pressed)}
                  >
                    top-K
                  </Toggle>
                </div>
              </li>
            ))}
            {visible.length === 0 && (
              <li className="rounded-lg border border-dashed px-3 py-2 text-center text-sm text-muted-foreground">
                No conversations
              </li>
            )}
          </ul>
        </CardContent>
      </Card>

      <CategoriesManager onChanged={handleChanged} />
      <QuickAdd categories={categories} onChanged={handleChanged} />
      <ProposalLedger refreshKey={refreshTick} />
      <EventsFeed refreshKey={refreshTick} />
      <HistoryPanel refreshKey={refreshTick} />
      <DangerZone onChanged={handleChanged} />

      <ImportDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        onImported={async () => {
          await handleChanged();
        }}
      />
    </div>
  );
}

interface ImportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onImported: () => void | Promise<void>;
}

function ImportDialog({ open, onOpenChange, onImported }: ImportDialogProps) {
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // The raw Claude conversations.json goes straight to the backend (§8.1).
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
