import { useState } from "react";
import { MoonStar } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { AdminDashboard } from "./components/AdminDashboard";
import { CategoryCard } from "./components/CategoryCard";
import { EditSheet } from "./components/EditSheet";
import { ExperimentCard } from "./components/ExperimentCard";
import { ReviewProposed } from "./components/ReviewProposed";
import {
  CATEGORY_LABELS,
  experiment,
  initialAccepted,
  initialConversations,
  initialItems,
  initialProposed,
  type CategoryKey,
  type Conversation,
  type Item,
} from "./data";
import "./index.css";

type View = "dashboard" | "review";

export function App() {
  const [view, setView] = useState<View>("dashboard");
  const [admin, setAdmin] = useState(false);
  const [editing, setEditing] = useState<CategoryKey | null>(null);
  const [items, setItems] = useState<Record<CategoryKey, Item[]>>(initialItems);
  const [accepted, setAccepted] = useState<Record<CategoryKey, Item[]>>(initialAccepted);
  const [proposed, setProposed] = useState<Record<CategoryKey, Item[]>>(initialProposed);
  const [conversations, setConversations] = useState<Conversation[]>(initialConversations);

  const proposedCount = proposed.goals.length + proposed.habits.length + proposed.environment.length;

  // sheet X: current item moves back into the "proposed and accepted" pool
  const removeItem = (category: CategoryKey, id: string) => {
    const item = items[category].find(i => i.id === id);
    if (!item) return;
    setItems(prev => ({ ...prev, [category]: prev[category].filter(i => i.id !== id) }));
    setAccepted(prev => ({ ...prev, [category]: [...prev[category], { ...item, active: false }] }));
  };

  // sheet +: pool item becomes a current item
  const addItem = (category: CategoryKey, id: string) => {
    const item = accepted[category].find(i => i.id === id);
    if (!item) return;
    setAccepted(prev => ({ ...prev, [category]: prev[category].filter(i => i.id !== id) }));
    setItems(prev => ({ ...prev, [category]: [...prev[category], item] }));
  };

  // accepted goals go to the pool; accepted environment/habit items go straight into the items
  const acceptProposed = (category: CategoryKey, id: string) => {
    const item = proposed[category].find(i => i.id === id);
    if (!item) return;
    setProposed(prev => ({ ...prev, [category]: prev[category].filter(i => i.id !== id) }));
    if (category === "goals") {
      setAccepted(prev => ({ ...prev, [category]: [...prev[category], item] }));
    } else {
      setItems(prev => ({ ...prev, [category]: [...prev[category], item] }));
    }
  };

  const rejectProposed = (category: CategoryKey, id: string) => {
    setProposed(prev => ({ ...prev, [category]: prev[category].filter(i => i.id !== id) }));
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
          <AdminDashboard conversations={conversations} onConversationsChange={setConversations} />
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
                  800
                  <br />
                  experiences
                </p>
                <Button variant="outline" size="sm">
                  open
                </Button>
              </CardContent>
            </Card>
            <ExperimentCard experiment={experiment} className="order-1 md:order-5 md:col-span-4" />
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
