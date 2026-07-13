import { api } from "@/lib/api";
import { useApiData } from "@/lib/useApiData";

// Demoted, deliberately: the writeup is glance bait at the bottom of the feed,
// not the trajectory. The trajectory is the experiment log.
export function WriteupFootnote({ tick }: { tick: number }) {
  const { data: writeup } = useApiData(() => api.writeupToday(), [tick]);
  if (!writeup) return null;
  return (
    <blockquote className="border-l-2 pl-3 text-sm italic text-muted-foreground">
      {writeup.text}
      <span className="ml-2 not-italic text-xs">— {writeup.date}</span>
    </blockquote>
  );
}
