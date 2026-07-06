import { useRef, useState } from "react";
import { Check, ChevronDown, Upload } from "lucide-react";

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
import { cn } from "@/lib/utils";
import { CATEGORIES, type Conversation } from "../data";

const DERIVE_SCOPES = ["all", "uncategorized", ...CATEGORIES];

interface AdminDashboardProps {
  conversations: Conversation[];
  onConversationsChange: (conversations: Conversation[]) => void;
}

export function AdminDashboard({ conversations, onConversationsChange }: AdminDashboardProps) {
  const [dailyEnabled, setDailyEnabled] = useState(true);
  const [deriveScope, setDeriveScope] = useState("all");
  const [search, setSearch] = useState("");
  const [uncategorizedOnly, setUncategorizedOnly] = useState(false);
  const [importOpen, setImportOpen] = useState(false);

  const visible = conversations.filter(c => {
    if (uncategorizedOnly && c.category) return false;
    return c.title.toLowerCase().includes(search.toLowerCase());
  });

  const updateConversation = (id: string, patch: Partial<Conversation>) => {
    onConversationsChange(conversations.map(c => (c.id === id ? { ...c, ...patch } : c)));
  };

  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Button
          variant="outline"
          className={cn(
            dailyEnabled &&
              "border-green-300 bg-green-200/70 hover:bg-green-200 dark:border-green-800 dark:bg-green-900/40 dark:hover:bg-green-900/60",
          )}
          onClick={() => setDailyEnabled(v => !v)}
        >
          run daily {dailyEnabled && <Check />} 21:00
        </Button>
        <Button variant="outline">run categorize</Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline">
              run derive ({deriveScope} <ChevronDown />)
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            {DERIVE_SCOPES.map(scope => (
              <DropdownMenuItem key={scope} onClick={() => setDeriveScope(scope)}>
                {scope}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <Button variant="outline" onClick={() => setImportOpen(true)}>
          import convo json file
        </Button>
      </div>

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
                      {CATEGORIES.map(cat => (
                        <DropdownMenuItem
                          key={cat}
                          onClick={() => updateConversation(c.id, { category: cat })}
                        >
                          {cat}
                        </DropdownMenuItem>
                      ))}
                      <DropdownMenuItem onClick={() => updateConversation(c.id, { category: null })}>
                        uncategorized
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                  <Toggle
                    variant="outline"
                    size="sm"
                    pressed={c.topK}
                    onPressedChange={pressed => updateConversation(c.id, { topK: pressed })}
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

      <ImportDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        onImport={imported => {
          onConversationsChange([...imported, ...conversations]);
          setImportOpen(false);
        }}
      />
    </div>
  );
}

interface ImportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onImport: (conversations: Conversation[]) => void;
}

function ImportDialog({ open, onOpenChange, onImport }: ImportDialogProps) {
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFile = async (file: File) => {
    setError(null);
    try {
      const raw = JSON.parse(await file.text());
      const entries: unknown[] = Array.isArray(raw) ? raw : (raw.conversations ?? []);
      const imported = entries
        .filter((e): e is Record<string, unknown> => typeof e === "object" && e !== null)
        .map((e, i) => ({
          id: `imported-${Date.now()}-${i}`,
          date: typeof e.date === "string" ? e.date : "07-07",
          title: typeof e.title === "string" ? e.title : `untitled conversation ${i + 1}`,
          slug: false,
          category: null,
          topK: false,
        }));
      if (imported.length === 0) {
        setError("No conversations found in that file.");
        return;
      }
      onImport(imported);
    } catch {
      setError("Could not parse that file as JSON.");
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={o => {
        setError(null);
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
          <Upload className="size-6" />
          <span className="text-lg">
            drop
            <br />
            conversations.json
          </span>
        </button>
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
