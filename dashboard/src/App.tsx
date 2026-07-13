import { useEffect, useState } from "react";
import { MoonStar } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { api } from "@/lib/api";
import { useApiData } from "@/lib/useApiData";
import { AdminDashboard } from "./components/AdminDashboard";
import { ExtractionReview } from "./screens/ExtractionReview";
import { MainFeed } from "./screens/MainFeed";
import { ProposalReview } from "./screens/ProposalReview";
import { ScheduleChat } from "./screens/ScheduleChat";
import "./index.css";

// View shell: the feed is home; review screens and the schedule chat are
// full-screen takeovers; admin is a mode.
export type View =
  | { name: "feed" }
  | { name: "review-extractions"; conversationId: string }
  | { name: "review-proposals" }
  | { name: "schedule-chat"; sessionId: string };

export function App() {
  const [view, setView] = useState<View>({ name: "feed" });
  const [admin, setAdmin] = useState(false);
  const [tick, setTick] = useState(0); // bumped after any mutation to refresh badges
  const bump = () => setTick(t => t + 1);

  useEffect(() => {
    api.visit().catch(() => {}); // the glance ping
  }, []);

  const { data: pendingProposals } = useApiData(() => api.proposals(), [tick]);
  const { data: awaitingReview } = useApiData(
    () => api.conversations({ state: "awaiting_review" }),
    [tick],
  );
  const proposedCount = pendingProposals?.length ?? 0;
  const readBackCount = awaitingReview?.length ?? 0;

  const logo = (
    <button className="flex items-center gap-2" onClick={() => setView({ name: "feed" })}>
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
    </button>
  );

  const reviewButton = (
    <Button
      variant={view.name === "review-proposals" ? "secondary" : "ghost"}
      onClick={() =>
        setView(view.name === "review-proposals" ? { name: "feed" } : { name: "review-proposals" })
      }
    >
      review proposed ({proposedCount})
    </Button>
  );

  const modeToggle = (
    <div className="flex items-center gap-2">
      <Label htmlFor="mode-toggle" className="text-sm">
        {admin ? "user toggle" : "admin toggle"}
      </Label>
      <Switch
        id="mode-toggle"
        checked={admin}
        onCheckedChange={checked => {
          setAdmin(checked);
          setView({ name: "feed" });
        }}
      />
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
          <AdminDashboard
            onChanged={bump}
            onReviewExtractions={id => {
              setAdmin(false);
              setView({ name: "review-extractions", conversationId: id });
            }}
          />
        ) : view.name === "review-extractions" ? (
          <ExtractionReview
            conversationId={view.conversationId}
            onDone={() => {
              bump();
              setView({ name: "feed" });
            }}
          />
        ) : view.name === "review-proposals" ? (
          <ProposalReview
            onChanged={bump}
            onBack={() => setView({ name: "feed" })}
          />
        ) : view.name === "schedule-chat" ? (
          <ScheduleChat
            sessionId={view.sessionId}
            onDone={() => {
              bump();
              setView({ name: "feed" });
            }}
          />
        ) : (
          <MainFeed
            tick={tick}
            onChanged={bump}
            readBackCount={readBackCount}
            awaitingReview={awaitingReview ?? []}
            onReviewExtractions={id => setView({ name: "review-extractions", conversationId: id })}
            onOpenScheduleChat={sessionId => setView({ name: "schedule-chat", sessionId })}
          />
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
    </div>
  );
}

export default App;
