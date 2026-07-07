import { useCallback, useEffect, useState } from "react";
import { MoonStar } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { api, type ExperimentRow, type ProposalRow, type WriteupRow } from "@/lib/api";
import { AdminDashboard } from "./components/AdminDashboard";
import { CategoryCard } from "./components/CategoryCard";
import { type CategoryMapEntry } from "./components/CategoryMap";
import { EditSheet } from "./components/EditSheet";
import { ExperimentCard } from "./components/ExperimentCard";
import { ReviewProposed } from "./components/ReviewProposed";
import {
  CATEGORY_LABELS,
  type CategoryKey,
  type Conversation,
  type Item,
  type ReviewKey,
} from "./data";
import "./index.css";

type View = "dashboard" | "review";

const EMPTY_BUCKETS: Record<CategoryKey, Item[]> = { goals: [], habits: [], environment: [] };

// Map pending proposals into the review sections (SPEC amendment 8 + plan mapping).
function proposalToReview(p: ProposalRow): { section: ReviewKey; item: Item } | null {
  const src: string[] = p.payload?.source_conversation_ids ?? [];
  switch (p.kind) {
    case "goal_create":
      return { section: "goals", item: { id: p.id, text: p.payload.title, sources: src } };
    case "goal_update":
      return {
        section: "goals",
        item: { id: p.id, text: `update: ${p.payload.title ?? p.payload.reason}`, sources: src },
      };
    case "synthesis_update":
      return {
        section: "goals",
        item: { id: p.id, text: `synthesis: ${p.payload.reason}`, sources: src },
      };
    case "goal_status":
      return {
        section: "goals",
        item: { id: p.id, text: `→ ${p.payload.status}: ${p.payload.reason}`, sources: src },
      };
    case "registry_add": {
      const section =
        p.payload.registry_kind === "habit"
          ? "habits"
          : p.payload.registry_kind === "environment"
            ? "environment"
            : null;
      if (!section) return null; // experiences have no card yet
      return { section, item: { id: p.id, text: p.payload.title, sources: src } };
    }
    case "registry_prune":
      return {
        section: "habits",
        item: { id: p.id, text: `prune: ${p.payload.reason}`, sources: src },
      };
    case "categorization": {
      const cats = (p.payload.categorizations ?? [])
        .map((c: any) => c.new_category?.name ?? c.category_name ?? "existing category")
        .join(", ");
      const extras = (p.payload.registry_adds ?? []).length;
      return {
        section: "filing",
        item: {
          id: p.id,
          text: `file rant → ${cats || "?"}${extras ? ` (+${extras} registry)` : ""}`,
          sources: src,
        },
      };
    }
    default:
      return null;
  }
}

export function App() {
  const [view, setView] = useState<View>("dashboard");
  const [admin, setAdmin] = useState(false);
  const [editing, setEditing] = useState<CategoryKey | null>(null);
  const [items, setItems] = useState<Record<CategoryKey, Item[]>>(EMPTY_BUCKETS);
  const [accepted, setAccepted] = useState<Record<CategoryKey, Item[]>>(EMPTY_BUCKETS);
  const [proposed, setProposed] = useState<Record<ReviewKey, Item[]>>({
    ...EMPTY_BUCKETS,
    filing: [],
  });
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [experiment, setExperiment] = useState<ExperimentRow | null>(null);
  const [writeup, setWriteup] = useState<WriteupRow | null>(null);
  const [experienceCount, setExperienceCount] = useState(0);
  const [categoryMap, setCategoryMap] = useState<CategoryMapEntry[]>([]);

  const refresh = useCallback(async () => {
    const [goals, habits, environment, experiences, proposals, convos, exp, wu, cats] =
      await Promise.all([
        api.goals(),
        api.registry("habit"),
        api.registry("environment"),
        api.registry("experience", "active"),
        api.proposals(),
        api.conversations(),
        api.currentExperiment(),
        api.writeupToday(),
        api.categories(),
      ]);

    // current items = active; the pool = backlog goals / removed registry items
    setItems({
      goals: goals
        .filter(g => g.status === "active")
        .map(g => ({ id: g.id, text: g.title, active: true })),
      habits: habits
        .filter(r => r.status === "active")
        .map(r => ({ id: r.id, text: r.title, active: true })),
      environment: environment
        .filter(r => r.status === "active")
        .map(r => ({ id: r.id, text: r.title, active: true })),
    });
    setAccepted({
      goals: goals
        .filter(g => g.status === "backlog" || g.status === "suggested")
        .map(g => ({ id: g.id, text: g.title })),
      habits: habits.filter(r => r.status === "removed").map(r => ({ id: r.id, text: r.title })),
      environment: environment
        .filter(r => r.status === "removed")
        .map(r => ({ id: r.id, text: r.title })),
    });
    setExperienceCount(experiences.length);

    const catNameById = new Map(cats.map(c => [c.id, c.name]));
    const categoryOf = (scopeKey: string) =>
      scopeKey.startsWith("category:") ? catNameById.get(scopeKey.slice("category:".length)) : undefined;

    const buckets: Record<ReviewKey, Item[]> = {
      goals: [],
      habits: [],
      environment: [],
      filing: [],
    };
    for (const p of proposals) {
      const mapped = proposalToReview(p);
      if (mapped) {
        mapped.item.category = categoryOf(p.scopeKey);
        buckets[mapped.section].push(mapped.item);
      }
    }
    setProposed(buckets);

    // The garden map: category → its goals + its filed rants.
    const entries: CategoryMapEntry[] = cats.map(cat => ({
      id: cat.id,
      name: cat.name,
      description: cat.description,
      goals: goals
        .filter(g => g.categoryId === cat.id)
        .map(g => ({ id: g.id, title: g.title, status: g.status })),
      rants: convos
        .filter(c => c.links.some(l => l.categoryId === cat.id))
        .map(c => ({
          id: c.id,
          title: c.title ?? "(untitled)",
          date: (c.sourceUpdatedAt ?? "").slice(0, 10),
          active: c.links.find(l => l.categoryId === cat.id)!.activeForDerive,
        })),
    }));
    const unfiled = goals.filter(g => !g.categoryId);
    if (unfiled.length > 0) {
      entries.push({
        id: "uncategorized",
        name: "uncategorized",
        description: "goals not yet attached to a category",
        goals: unfiled.map(g => ({ id: g.id, title: g.title, status: g.status })),
        rants: [],
      });
    }
    setCategoryMap(entries);

    setConversations(
      convos.map(c => ({
        id: c.id,
        date: (c.sourceUpdatedAt ?? "").slice(5, 10) || "?",
        title: c.title ?? "(untitled)",
        slug: c.slugDetected,
        category: c.links[0]?.categoryName ?? null,
        categoryId: c.links[0]?.categoryId ?? null,
        linkId: c.links[0]?.id ?? null,
        topK: c.links[0]?.activeForDerive ?? false,
      })),
    );
    setExperiment(exp);
    setWriteup(wu);
  }, []);

  useEffect(() => {
    api.visit().catch(() => {}); // the glance ping (§7.13)
    refresh().catch(err => console.error("initial load failed:", err));
  }, [refresh]);

  const proposedCount =
    proposed.goals.length +
    proposed.habits.length +
    proposed.environment.length +
    proposed.filing.length;

  // sheet X: active goal → backlog; active registry item → removed
  const removeItem = async (category: CategoryKey, id: string) => {
    if (category === "goals") await api.patchGoalStatus(id, "backlog");
    else await api.patchRegistry(id, { status: "removed" });
    await refresh();
  };

  // sheet +: pool item becomes current again
  const addItem = async (category: CategoryKey, id: string) => {
    if (category === "goals") await api.patchGoalStatus(id, "active");
    else await api.patchRegistry(id, { status: "active" });
    await refresh();
  };

  const acceptProposed = async (_section: ReviewKey, id: string) => {
    await api.approveProposal(id);
    await refresh();
  };

  const rejectProposed = async (_section: ReviewKey, id: string) => {
    await api.denyProposal(id);
    await refresh();
  };

  const logo = (
    <div className="flex items-center gap-2">
      <span className="flex size-8 items-center justify-center rounded-lg bg-foreground text-background">
        <MoonStar className="size-5" />
      </span>
      <span className="font-semibold">dream coach</span>
      <Badge
        className={
          admin
            ? "border-transparent bg-amber-200 text-amber-900 dark:bg-amber-900 dark:text-amber-100"
            : "border-transparent bg-emerald-200 text-emerald-900 dark:bg-emerald-900 dark:text-emerald-100"
        }
      >
        {admin ? "admin" : "user"}
      </Badge>
    </div>
  );

  const reviewButton = (
    <Button
      variant={view === "review" ? "secondary" : "ghost"}
      onClick={() => setView(view === "review" ? "dashboard" : "review")}
    >
      review proposed ({proposedCount})
    </Button>
  );

  const modeToggle = (
    <div className="flex items-center gap-2">
      <Label htmlFor="mode-toggle" className="text-sm">
        {admin ? "user toggle" : "admin toggle"}
      </Label>
      <Switch id="mode-toggle" checked={admin} onCheckedChange={setAdmin} />
    </div>
  );

  return (
    <div className="mx-auto w-full max-w-6xl px-4 pb-24 md:pb-8">
      <header className="mb-6 flex items-center justify-between gap-4 border-b py-3">
        {logo}
        <div className="hidden items-center gap-4 md:flex">
          {!admin && reviewButton}
          {modeToggle}
        </div>
      </header>

      <main>
        {admin ? (
          <AdminDashboard conversations={conversations} onChanged={refresh} />
        ) : view === "review" ? (
          <ReviewProposed proposed={proposed} onAccept={acceptProposed} onReject={rejectProposed} />
        ) : (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
            <CategoryCard
              title={CATEGORY_LABELS.goals}
              items={items.goals}
              onEdit={() => setEditing("goals")}
              className="order-2 md:order-1"
            />
            <CategoryCard
              title={CATEGORY_LABELS.habits}
              items={items.habits}
              onEdit={() => setEditing("habits")}
              className="order-4 md:order-2"
            />
            <CategoryCard
              title={CATEGORY_LABELS.environment}
              items={items.environment}
              onEdit={() => setEditing("environment")}
              className="order-3 md:order-3"
            />
            <Card className="order-5 hidden border-dashed py-4 md:order-4 md:flex">
              <CardContent className="flex flex-1 flex-col items-center justify-center gap-3 px-4 text-muted-foreground">
                <p className="text-center text-sm">
                  {experienceCount}
                  <br />
                  experiences
                </p>
                <Button variant="outline" size="sm">
                  open
                </Button>
              </CardContent>
            </Card>
            <ExperimentCard
              experiment={experiment}
              writeup={writeup}
              categories={categoryMap}
              onChanged={refresh}
              className="order-1 md:order-5 md:col-span-4"
            />
          </div>
        )}
      </main>

      <nav
        className={
          "fixed inset-x-0 bottom-0 z-10 grid items-center border-t bg-background md:hidden " +
          (admin ? "grid-cols-1" : "grid-cols-2")
        }
      >
        <div className={"flex justify-center py-3 " + (admin ? "" : "border-r")}>{modeToggle}</div>
        {!admin && <div className="flex justify-center py-3">{reviewButton}</div>}
      </nav>

      {editing && (
        <EditSheet
          open
          onOpenChange={open => !open && setEditing(null)}
          title={CATEGORY_LABELS[editing]}
          items={items[editing]}
          accepted={accepted[editing]}
          onRemove={id => removeItem(editing, id)}
          onAdd={id => addItem(editing, id)}
        />
      )}
    </div>
  );
}

export default App;
