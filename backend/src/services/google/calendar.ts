import { getAccessToken } from "./auth";

// Hand-rolled Google Calendar v3 client over Bun fetch — one API surface,
// zero new deps. All methods throw GoogleApiError with the status attached so
// the sync layer can branch on 410 (expired sync token).

const BASE = "https://www.googleapis.com/calendar/v3";

export class GoogleApiError extends Error {
  constructor(
    public status: number,
    body: string,
  ) {
    super(`google calendar ${status}: ${body}`);
  }
}

async function call<T>(method: string, path: string, body?: unknown, query?: Record<string, string>): Promise<T> {
  const token = await getAccessToken();
  const url = new URL(`${BASE}${path}`);
  for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, v);
  const res = await fetch(url, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new GoogleApiError(res.status, await res.text());
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

export interface GcalEvent {
  id: string;
  status?: string; // "cancelled" for deletions in sync feeds
  summary?: string;
  description?: string;
  start?: { dateTime?: string; date?: string; timeZone?: string };
  end?: { dateTime?: string; date?: string; timeZone?: string };
  recurrence?: string[];
  recurringEventId?: string; // set on exception instances
  colorId?: string;
  extendedProperties?: { private?: Record<string, string> };
}

export interface EventsPage {
  items: GcalEvent[];
  nextPageToken?: string;
  nextSyncToken?: string;
}

export const gcal = {
  listCalendars: () =>
    call<{ items: { id: string; summary: string }[] }>("GET", "/users/me/calendarList"),

  insertCalendar: (summary: string) =>
    call<{ id: string }>("POST", "/calendars", { summary }),

  insertEvent: (calendarId: string, event: Omit<GcalEvent, "id">) =>
    call<GcalEvent>("POST", `/calendars/${encodeURIComponent(calendarId)}/events`, event),

  patchEvent: (calendarId: string, eventId: string, patch: Partial<GcalEvent>) =>
    call<GcalEvent>(
      "PATCH",
      `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
      patch,
    ),

  deleteEvent: (calendarId: string, eventId: string) =>
    call<void>("DELETE", `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`),

  listEvents: (calendarId: string, query: Record<string, string>) =>
    call<EventsPage>("GET", `/calendars/${encodeURIComponent(calendarId)}/events`, undefined, query),

  freebusy: (timeMin: string, timeMax: string, calendarIds: string[]) =>
    call<{ calendars: Record<string, { busy: { start: string; end: string }[] }> }>("POST", "/freeBusy", {
      timeMin,
      timeMax,
      items: calendarIds.map(id => ({ id })),
    }),
};
