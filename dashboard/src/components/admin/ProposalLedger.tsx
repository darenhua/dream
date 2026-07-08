import { useEffect, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Toggle } from "@/components/ui/toggle";
import { api, type ProposalRow } from "@/lib/api";
import { cn } from "@/lib/utils";

type LedgerRow = ProposalRow & { createdAt: string; denialNote: string | null };

const STATUSES = ["all", "pending", "approved", "denied", "superseded"] as const;

const STATUS_STYLE: Record<string, string> = {
  pending: "bg-amber-200 text-amber-900 dark:bg-amber-900 dark:text-amber-100",
  approved: "bg-green-200 text-green-900 dark:bg-green-900 dark:text-green-100",
  denied: "bg-red-200 text-red-900 dark:bg-red-900 dark:text-red-100",
  superseded: "bg-muted text-muted-foreground",
};

function summarize(p: LedgerRow): string {
  const pl = p.payload ?? {};
  if (p.kind === "categorization") {
    const names = (pl.categorizations ?? [])
      .map((c: any) => c.new_category?.name ?? "existing")
      .join(", ");
    return `file rant → ${names || "?"}`;
  }
  return pl.title ?? pl.reason ?? pl.synthesis_md?.slice(0, 60) ?? "(no summary)";
}

// Tier 3: the full proposal ledger — denied and superseded proposals stop vanishing.
export function ProposalLedger({ refreshKey }: { refreshKey: number }) {
  const [rows, setRows] = useState<LedgerRow[]>([]);
  const [filter, setFilter] = useState<(typeof STATUSES)[number]>("all");
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    api
      .allProposals(filter === "all" ? undefined : filter)
      .then(setRows)
      .catch(() => setRows([]));
  }, [filter, refreshKey]);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base font-medium">proposal ledger</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex flex-wrap gap-2">
          {STATUSES.map(status => (
            <Toggle
              key={status}
              variant="outline"
              size="sm"
              pressed={filter === status}
              onPressedChange={() => setFilter(status)}
            >
              {status}
            </Toggle>
          ))}
        </div>
        <ul className="flex flex-col gap-2">
          {rows.map(p => (
            <li key={p.id} className="rounded-lg border">
              <button
                type="button"
                className="flex w-full flex-wrap items-center gap-2 px-3 py-2 text-left text-sm"
                onClick={() => setExpanded(expanded === p.id ? null : p.id)}
              >
                <Badge className={cn("border-transparent", STATUS_STYLE[p.status])}>{p.status}</Badge>
                <span className="font-mono text-xs text-muted-foreground">{p.kind}</span>
                <span className="min-w-0 flex-1 truncate">{summarize(p)}</span>
                <span className="text-xs text-muted-foreground">{p.createdAt.slice(0, 16).replace("T", " ")}</span>
              </button>
              {expanded === p.id && (
                <div className="border-t px-3 py-2">
                  {p.denialNote && (
                    <p className="mb-2 text-xs text-muted-foreground">denial note: {p.denialNote}</p>
                  )}
                  <pre className="max-h-64 overflow-auto rounded bg-muted/50 p-2 text-xs">
                    {JSON.stringify(p.payload, null, 2)}
                  </pre>
                </div>
              )}
            </li>
          ))}
          {rows.length === 0 && (
            <li className="rounded-lg border border-dashed px-3 py-2 text-center text-sm text-muted-foreground">
              No proposals{filter !== "all" ? ` with status "${filter}"` : ""}.
            </li>
          )}
        </ul>
      </CardContent>
    </Card>
  );
}
