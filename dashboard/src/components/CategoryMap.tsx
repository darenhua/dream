import { useState } from "react";

import { cn } from "@/lib/utils";
import type { Item } from "../data";
import { TranscriptDialog } from "./TranscriptDialog";

// The garden map: one tile per category — its goals as pills, its rants as a
// dated list. Deliberately not a graph (the vision rejects goal-relationship
// graphs); a shallow hierarchy reads best as tiles in the quote-box style.

export interface CategoryMapEntry {
  id: string;
  name: string;
  description: string | null;
  goals: { id: string; title: string; status: string }[];
  rants: { id: string; title: string; date: string; active: boolean }[];
}

export function CategoryMap({ categories }: { categories: CategoryMapEntry[] }) {
  const [selected, setSelected] = useState<Item | null>(null);

  if (categories.length === 0) return null;

  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
      {categories.map(cat => (
        <div key={cat.id} className="flex min-w-0 flex-col gap-3 rounded-2xl bg-muted/50 p-4">
          <div>
            <h3 className="text-sm font-semibold">{cat.name}</h3>
            {cat.description && (
              <p className="line-clamp-2 text-xs text-muted-foreground">{cat.description}</p>
            )}
          </div>

          {cat.goals.length > 0 && (
            <ul className="flex flex-wrap gap-1.5">
              {cat.goals.map(goal => (
                <li
                  key={goal.id}
                  className={cn(
                    "rounded-full border px-2.5 py-0.5 text-xs",
                    goal.status === "active"
                      ? "border-green-300 bg-green-200/70 dark:border-green-800 dark:bg-green-900/40"
                      : "bg-card text-muted-foreground",
                  )}
                >
                  {goal.title}
                </li>
              ))}
            </ul>
          )}

          <ul className="flex flex-col gap-1">
            {cat.rants.map(rant => (
              <li key={rant.id}>
                <button
                  type="button"
                  className={cn(
                    "w-full truncate text-left text-xs hover:text-foreground",
                    rant.active ? "text-muted-foreground" : "text-muted-foreground/60",
                  )}
                  onClick={() =>
                    setSelected({ id: rant.id, text: rant.title, sources: [rant.id] })
                  }
                  title={rant.active ? rant.title : `${rant.title} (resting — outside the top-K working set)`}
                >
                  {rant.date} · {rant.title}
                </button>
              </li>
            ))}
            {cat.rants.length === 0 && (
              <li className="text-xs italic text-muted-foreground">no rants filed yet</li>
            )}
          </ul>
        </div>
      ))}
      <TranscriptDialog item={selected} onClose={() => setSelected(null)} />
    </div>
  );
}
