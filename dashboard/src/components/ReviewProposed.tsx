import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { CategoryKey, Item } from "../data";
import { ProposedTable } from "./ProposedTable";

interface ReviewProposedProps {
  proposed: Record<CategoryKey, Item[]>;
  onAccept: (category: CategoryKey, id: string) => void;
  onReject: (category: CategoryKey, id: string) => void;
}

const SECTIONS: { key: CategoryKey; title: string; description: string }[] = [
  {
    key: "goals",
    title: "proposed goals",
    description: "Accepted goals appear in the proposed and accepted list when editing goals.",
  },
  {
    key: "environment",
    title: "proposed environment",
    description: "Accepted items appear in the environment items.",
  },
  {
    key: "habits",
    title: "proposed habits",
    description: "Accepted items appear in the list of habit items.",
  },
];

export function ReviewProposed({ proposed, onAccept, onReject }: ReviewProposedProps) {
  return (
    <div className="flex flex-col gap-6">
      {SECTIONS.map(section => (
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
            />
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
