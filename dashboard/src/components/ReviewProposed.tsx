import { useState } from "react";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { Item, ReviewKey } from "../data";
import { ProposedTable } from "./ProposedTable";
import { TranscriptDialog } from "./TranscriptDialog";

interface ReviewProposedProps {
  proposed: Record<ReviewKey, Item[]>;
  onAccept: (section: ReviewKey, id: string) => void;
  onReject: (section: ReviewKey, id: string) => void;
}

const SECTIONS: { key: ReviewKey; title: string; description: string }[] = [
  {
    key: "filing",
    title: "filing",
    description: "Where the system wants to file new rants — approving links them for the next derive.",
  },
  {
    key: "goals",
    title: "proposed goals",
    description: "Accepted goals appear in the proposed and accepted list when editing goals.",
  },
  {
    key: "habits",
    title: "proposed habits",
    description: "Accepted habits are added to your current habits.",
  },
  {
    key: "environment",
    title: "proposed environment",
    description: "Accepted items are added to your current environment.",
  },
];

export function ReviewProposed({ proposed, onAccept, onReject }: ReviewProposedProps) {
  const [selected, setSelected] = useState<Item | null>(null);

  return (
    <div className="flex flex-col gap-6">
      {SECTIONS.filter(s => s.key !== "filing" || proposed.filing.length > 0).map(section => (
        <Card key={section.key}>
          <CardHeader>
            <CardTitle className="text-base font-medium">{section.title}</CardTitle>
            <CardDescription>{section.description}</CardDescription>
          </CardHeader>
          <CardContent>
            <ProposedTable
              items={proposed[section.key]}
              onAccept={id => onAccept(section.key, id)}
              onReject={id => onReject(section.key, id)}
              onRowClick={setSelected}
            />
          </CardContent>
        </Card>
      ))}
      <TranscriptDialog item={selected} onClose={() => setSelected(null)} />
    </div>
  );
}
