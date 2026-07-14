import type { ConversationRow } from "@/lib/api";
import { AnchorRow } from "../components/AnchorRow";
import { ExperimentQueue } from "../components/ExperimentQueue";
import { GoalsCard } from "../components/GoalsCard";
import { ListCards } from "../components/ListCards";
import { OutboxCard } from "../components/OutboxCard";
import { RantCandidatesGate } from "../components/RantCandidatesGate";
import { ReadBackGate } from "../components/ReadBackGate";
import { TodayStrip } from "../components/TodayStrip";
import { VitalsStrip } from "../components/VitalsStrip";
import { WitnessCard } from "../components/WitnessCard";
import { WriteupFootnote } from "../components/WriteupFootnote";

// The main feed, in attention order: anchors (one-tap), today's schedule,
// the experiment queue with the current one highlighted, the two human
// gates, the self-map cards, and the demoted writeup as a footnote.
export function MainFeed({
  tick,
  onChanged,
  readBackCount,
  awaitingReview,
  onReviewExtractions,
  onOpenScheduleChat,
  onOpenReview,
}: {
  tick: number;
  onChanged: () => void;
  readBackCount: number;
  awaitingReview: ConversationRow[];
  onReviewExtractions: (conversationId: string) => void;
  onOpenScheduleChat: (sessionId: string) => void;
  onOpenReview: (experimentId: string) => void;
}) {
  return (
    <div className="flex flex-col gap-4">
      <VitalsStrip tick={tick} />
      <AnchorRow tick={tick} onChanged={onChanged} />
      <TodayStrip tick={tick} />
      <RantCandidatesGate tick={tick} onChanged={onChanged} />
      {readBackCount > 0 && (
        <ReadBackGate conversations={awaitingReview} onReview={onReviewExtractions} />
      )}
      <OutboxCard tick={tick} onChanged={onChanged} />
      <ExperimentQueue
        tick={tick}
        onChanged={onChanged}
        onOpenScheduleChat={onOpenScheduleChat}
        onOpenReview={onOpenReview}
      />
      <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
        <GoalsCard tick={tick} onChanged={onChanged} />
        <ListCards tick={tick} onChanged={onChanged} />
      </div>
      <WitnessCard tick={tick} onChanged={onChanged} />
      <WriteupFootnote tick={tick} />
    </div>
  );
}
