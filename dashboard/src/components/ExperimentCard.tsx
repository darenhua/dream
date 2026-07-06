import { MoveRight } from "lucide-react";

import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { Experiment } from "../data";

interface ExperimentCardProps {
  experiment: Experiment;
  className?: string;
}

export function ExperimentCard({ experiment, className }: ExperimentCardProps) {
  return (
    <Card className={className}>
      <CardContent className="flex flex-col gap-6 md:flex-row">
        <div className="flex min-w-0 flex-col gap-5 md:basis-[70%]">
          <h2 className="text-lg font-semibold">
            {experiment.title}
            {/* days running is neutral info — never overdue styling */}
            <span className="font-normal text-muted-foreground"> · day {experiment.daysRunning}</span>
          </h2>
          <ul className="flex flex-1 flex-col justify-center gap-4">
            {experiment.intentions.slice(0, 3).map(intention => (
              <li
                key={intention.when}
                className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-xl font-medium md:text-2xl"
              >
                <span>
                  <span className="text-muted-foreground">When </span>
                  {intention.when}
                </span>
                <MoveRight className="size-5 shrink-0 self-center text-muted-foreground" />
                <span>{intention.then}</span>
              </li>
            ))}
          </ul>
        </div>
        <div
          className={cn(
            "flex min-w-0 items-center justify-center overflow-hidden rounded-2xl bg-muted/50 p-6 md:basis-[30%]",
          )}
        >
          <blockquote className="min-w-0 border-l-2 pl-4">
            <p className="line-clamp-6 break-words text-sm italic leading-relaxed md:text-base">
              “{experiment.quote.text}”
            </p>
            <footer className="mt-2 truncate text-sm text-muted-foreground">
              — {experiment.quote.author}
            </footer>
          </blockquote>
        </div>
      </CardContent>
    </Card>
  );
}
