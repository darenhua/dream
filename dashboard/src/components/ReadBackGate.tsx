import { BookOpenCheck } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import type { ConversationRow } from "@/lib/api";

// Human gate #1, as a door not a demand: rants the system has read and wants
// read back before it draws any conclusions.
export function ReadBackGate({
  conversations,
  onReview,
}: {
  conversations: ConversationRow[];
  onReview: (conversationId: string) => void;
}) {
  return (
    <Card className="border-emerald-300 dark:border-emerald-800">
      <CardContent className="flex flex-col gap-2 px-4 py-3">
        <div className="flex items-center gap-2 text-sm font-medium">
          <BookOpenCheck className="size-4" />
          {conversations.length} rant{conversations.length === 1 ? "" : "s"} waiting for your read-back
        </div>
        <ul className="flex flex-col gap-1">
          {conversations.map(c => (
            <li key={c.id} className="flex items-center justify-between gap-2 text-sm">
              <span className="min-w-0 truncate">
                <span className="mr-2 font-mono text-xs text-muted-foreground">
                  {(c.sourceUpdatedAt ?? "").slice(5, 10)}
                </span>
                {c.title ?? "(untitled)"}
              </span>
              <Button size="sm" variant="outline" onClick={() => onReview(c.id)}>
                did I hear you right?
              </Button>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
