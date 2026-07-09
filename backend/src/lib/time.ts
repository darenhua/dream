// Timezone-correct helpers, no deps: all free-time math runs in the user's
// configured TIMEZONE, never server UTC (the likeliest silent-bug source).

export function localDate(tz: string, d: Date = new Date()): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(d);
}

// Minutes since local midnight for an instant, in tz.
export function localMinutes(tz: string, d: Date = new Date()): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const h = Number(parts.find(p => p.type === "hour")?.value ?? 0);
  const m = Number(parts.find(p => p.type === "minute")?.value ?? 0);
  return (h === 24 ? 0 : h) * 60 + m;
}

export function hhmmToMin(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

export function minToHhmm(min: number): string {
  const clamped = Math.max(0, Math.min(1440, min));
  const h = Math.floor(clamped / 60) % 24;
  const m = clamped % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

// Day-of-week (0=Sunday..6=Saturday) of a YYYY-MM-DD in tz-independent terms:
// the date string is already local, so UTC construction is safe.
export function dayOfWeek(dateStr: string): number {
  return new Date(`${dateStr}T00:00:00Z`).getUTCDay();
}

// ISO datetime for a local date + minutes, expressed in tz. Computes the tz
// offset for that moment via Intl (handles DST) without any date library.
export function zonedIso(tz: string, dateStr: string, minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  // Start from the naive UTC guess, then correct by the tz offset at that time.
  const naive = new Date(`${dateStr}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00Z`);
  const offsetMin = tzOffsetMinutes(tz, naive);
  return new Date(naive.getTime() - offsetMin * 60_000).toISOString();
}

// Offset of tz from UTC (positive = ahead of UTC) at the given instant.
export function tzOffsetMinutes(tz: string, at: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(at);
  const get = (t: string) => Number(parts.find(p => p.type === t)?.value ?? 0);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour") % 24, get("minute"), get("second"));
  return Math.round((asUtc - at.getTime()) / 60_000);
}
