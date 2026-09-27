import type { CalendarEvent } from "../../services/calendar";

/**
 * Start/end value in Google Calendar's Event resource, as returned by `gws calendar events *`
 * (docs/spikes/gws-cli-0.22.5.md §4: identical field names to the old MCP server's StructuredEvent).
 */
export interface GoogleDateTime {
  /** RFC 3339 timestamp for timed events. */
  dateTime?: string;
  /** YYYY-MM-DD for all-day events. */
  date?: string;
  /** IANA time zone of the value. */
  timeZone?: string;
}

/**
 * Subset of Google Calendar's Event resource that the adapter consumes.
 */
export interface GoogleEvent {
  id: string;
  summary?: string;
  description?: string;
  location?: string;
  /** "confirmed" for a normal event, "cancelled" for a deleted one (see docs/spikes/gws-cli-0.22.5.md §8). */
  status?: string;
  start: GoogleDateTime;
  end: GoogleDateTime;
}

/**
 * Converts a raw Event resource into the shared CalendarEvent model.
 * @param account Nickname of the account the event was fetched from; always set once accounts are configured.
 * @param calendarId Id of the calendar the event was fetched from, when multiple calendars are configured.
 */
export function toCalendarEvent(raw: unknown, account?: string, calendarId?: string): CalendarEvent {
  if (!isGoogleEvent(raw)) {
    throw new Error(`Unexpected event shape from gws: ${JSON.stringify(raw)}`);
  }

  const event: CalendarEvent = {
    id: raw.id,
    // Google allows events without a title; keep the model's title non-optional.
    title: raw.summary ?? "",
    start: parseGoogleDateTime(raw.start, `${raw.id}.start`),
    end: parseGoogleDateTime(raw.end, `${raw.id}.end`),
    allDay: raw.start.date !== undefined,
  };
  if (raw.description !== undefined) event.description = raw.description;
  if (raw.location !== undefined) event.location = raw.location;
  if (account !== undefined) event.account = account;
  if (calendarId !== undefined) event.calendarId = calendarId;
  return event;
}

/**
 * Formats a Date as the RFC 3339 timestamp gws's timeMin/timeMax query parameters expect.
 * Google rejects sub-second precision, so Date#toISOString()'s milliseconds are stripped.
 */
export function toTimestamp(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * Builds a timed start/end value for gws's `--json` request body.
 * @param timeZone IANA zone to attach, so the API interprets ambiguous local times correctly; omitted (rather
 * than sent as undefined) when not configured, since toTimestamp already encodes an unambiguous UTC instant.
 */
export function toRfc3339(date: Date, timeZone?: string): GoogleDateTime {
  return timeZone ? { dateTime: toTimestamp(date), timeZone } : { dateTime: toTimestamp(date) };
}

/**
 * Builds an all-day start/end value for gws's `--json` request body, as YYYY-MM-DD in local time.
 */
export function toDateOnly(date: Date): GoogleDateTime {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return { date: `${y}-${m}-${d}` };
}

/**
 * Parses a start/end value from gws. All-day dates become local midnight to match toDateOnly.
 */
function parseGoogleDateTime(value: GoogleDateTime, where: string): Date {
  if (value.dateTime !== undefined) {
    const parsed = new Date(value.dateTime);
    if (Number.isNaN(parsed.getTime())) throw new Error(`Invalid dateTime at ${where}: ${value.dateTime}`);
    return parsed;
  }
  if (value.date !== undefined) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.date);
    if (!match) throw new Error(`Invalid date at ${where}: ${value.date}`);
    return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  }
  throw new Error(`Missing dateTime/date at ${where}`);
}

/**
 * Structural check for the fields toCalendarEvent (and the adapter's get-before-replace path) rely on.
 */
export function isGoogleEvent(value: unknown): value is GoogleEvent {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string" &&
    typeof v.start === "object" &&
    v.start !== null &&
    typeof v.end === "object" &&
    v.end !== null
  );
}
