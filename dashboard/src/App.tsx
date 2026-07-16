import { useEffect, useState } from "react";
import { MoonStar } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { api } from "@/lib/api";
import { useApiData } from "@/lib/useApiData";
import { cn } from "@/lib/utils";
import { AdminDashboard } from "./components/AdminDashboard";
import { ExtractionReview } from "./screens/ExtractionReview";
import { MainFeed } from "./screens/MainFeed";
import { OrganizedFeed } from "./screens/OrganizedFeed";
import { ProposalReview } from "./screens/ProposalReview";
import { ReviewInterview } from "./screens/ReviewInterview";
import { ReviewWriteup } from "./screens/ReviewWriteup";
import { RantExplorer } from "./screens/RantExplorer";
import { ScheduleChat } from "./screens/ScheduleChat";
import { SteerChat } from "./screens/SteerChat";
import "./index.css";

// View shell: the feed is home; review screens and the chats are full-screen
// takeovers; admin is a mode with its own pages (dashboard, rant explorer).
export type View =
  | { name: "feed" }
  | { name: "review-extractions"; conversationId: string }
  | { name: "review-proposals" }
  | { name: "organized-feed" }
  | { name: "schedule-chat"; sessionId: string }
  | { name: "review-writeup"; experimentId: string }
  | { name: "review-interview"; sessionId: string; experimentId: string }
  | { name: "rant-explorer" }
  | { name: "steer-chat"; sessionId: string; targetType: "distill" | "proposal" | "goal" };

export function App() {
  const [view, setView] = useState<View>({ name: "feed" });
  const [admin, setAdmin] = useState(false);
  const [tick, setTick] = useState(0); // bumped after any mutation to refresh badges
  const bump = () => setTick(t => t + 1);
  // Where a steer chat returns to — it can be opened from either mode.
  const [steerReturn, setSteerReturn] = useState<View>({ name: "feed" });

  const openSteer = (targetType: "distill" | "proposal" | "goal") => (sessionId: string) => {
    setSteerReturn(view);
    setView({ name: "steer-chat", sessionId, targetType });
  };

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

  // The curated layer is a peer of proposal review, not a replacement for the
  // raw/proposal-derived feed. Both remain one click away in user mode.
  const organizedButton = (
    <Button
      variant={view.name === "organized-feed" ? "secondary" : "ghost"}
      onClick={() => setView(view.name === "organized-feed" ? { name: "feed" } : { name: "organized-feed" })}
    >
      organized feed
    </Button>
  );

  const explorerButton = (
    <Button
      variant={view.name === "rant-explorer" ? "secondary" : "ghost"}
      onClick={() =>
        setView(view.name === "rant-explorer" ? { name: "feed" } : { name: "rant-explorer" })
      }
    >
      rant explorer
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
          {!admin && (
            <>
              {reviewButton}
              {organizedButton}
            </>
          )}
          {admin && explorerButton}
          {modeToggle}
        </div>
      </header>

      <main>
        {view.name === "steer-chat" ? (
          <SteerChat
            sessionId={view.sessionId}
            targetType={view.targetType}
            onDone={() => {
              bump();
              setView(steerReturn);
            }}
            onCancel={() => setView(steerReturn)}
          />
        ) : admin && view.name === "rant-explorer" ? (
          <RantExplorer onOpenSteer={openSteer("distill")} />
        ) : admin ? (
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
            onOpenSteer={openSteer("distill")}
          />
        ) : view.name === "review-proposals" ? (
          <ProposalReview
            onChanged={bump}
            onBack={() => setView({ name: "feed" })}
            onOpenSteer={openSteer("proposal")}
          />
        ) : view.name === "organized-feed" ? (
          <OrganizedFeed tick={tick} onChanged={bump} />
        ) : view.name === "schedule-chat" ? (
          <ScheduleChat
            sessionId={view.sessionId}
            onDone={() => {
              bump();
              setView({ name: "feed" });
            }}
          />
        ) : view.name === "review-writeup" ? (
          <ReviewWriteup
            experimentId={view.experimentId}
            onOpenInterview={sessionId =>
              setView({ name: "review-interview", sessionId, experimentId: view.experimentId })
            }
            onBack={() => {
              bump();
              setView({ name: "feed" });
            }}
          />
        ) : view.name === "review-interview" ? (
          <ReviewInterview
            sessionId={view.sessionId}
            onDone={() => {
              bump();
              setView({ name: "review-writeup", experimentId: view.experimentId });
            }}
            onBack={() => setView({ name: "review-writeup", experimentId: view.experimentId })}
          />
        ) : (
          <MainFeed
            tick={tick}
            onChanged={bump}
            readBackCount={readBackCount}
            awaitingReview={awaitingReview ?? []}
            onReviewExtractions={id => setView({ name: "review-extractions", conversationId: id })}
            onOpenScheduleChat={sessionId => setView({ name: "schedule-chat", sessionId })}
            onOpenReview={experimentId => setView({ name: "review-writeup", experimentId })}
            onOpenGoalSteer={openSteer("goal")}
          />
        )}
      </main>

      <nav
        className={cn(
          "fixed inset-x-0 bottom-0 z-10 grid items-center border-t bg-background md:hidden",
          admin ? "grid-cols-2" : "grid-cols-3",
        )}
      >
        <div className="flex justify-center border-r py-3">{modeToggle}</div>
        {admin ? (
          <div className="flex justify-center py-3">{explorerButton}</div>
        ) : (
          <>
            <div className="flex justify-center border-r py-3">{reviewButton}</div>
            <div className="flex justify-center py-3">{organizedButton}</div>
          </>
        )}
      </nav>
    </div>
  );
}

export default App;
