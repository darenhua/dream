import { runText } from "./agentRunner";
import { busyByDate, isConnected } from "./calendarSync";
import { freeTimeForDates, renderFreeTimeReport, upcomingDates } from "./freeTime";
import { newWorkspace, projectPromptGenerator } from "./projector";

// The prompt generator: consolidates full state into a self-contained prompt
// the user pastes into the Claude app to rant toward their next experiment
// idea. The resulting conversation re-enters the system as a normal rant —
// the system never designs experiments from scratch; it helps the user rant
// productively.

export async function freeTimeReport(days = 7): Promise<string> {
  const dates = upcomingDates(days);
  if (!isConnected()) {
    const report = freeTimeForDates(dates, new Map());
    return renderFreeTimeReport(
      report,
      "_(google calendar not connected — computed from sleep/work windows only, no busy events)_",
    );
  }
  const busy = await busyByDate(dates);
  return renderFreeTimeReport(freeTimeForDates(dates, busy));
}

export async function generateExperimentPrompt(): Promise<
  { ok: true; markdown: string } | { ok: false; error: string }
> {
  const dir = newWorkspace("prompt_generator");
  projectPromptGenerator(dir, await freeTimeReport());
  const run = await runText("prompt_generator", dir, { trigger: "manual" });
  if (run.status !== "ok" || !run.output) {
    return { ok: false, error: run.error ?? "prompt generation failed" };
  }
  return { ok: true, markdown: run.output };
}
