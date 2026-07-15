import { busyByDate, isConnected } from "./calendarSync";
import { freeTimeForDates, renderFreeTimeReport, upcomingDates } from "./freeTime";

// The free-time report shared by every agent that schedules or shapes
// against the coming days. (The old paste-into-Claude prompt generator this
// module was named for is gone — shaping is an in-app conversation now.)

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
