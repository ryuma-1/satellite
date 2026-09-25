import type { CalendarEvent } from "../../services/calendar";

/**
 * Start/end value as returned by @cocal/google-calendar-mcp (mirrors the Google Calendar API).
 */
export interface McpDateTime {
  /** RFC 3339 timestamp for timed events. */
  dateTime?: string;
  /** YYYY-MM-DD for all-day events. */
  date?: string;
  /** IANA time zone of the value. */
  timeZone?: string;
}

/**
 * Subset of the server's StructuredEvent that the adapter consumes.
 */
export interface McpEvent {
  id: string;
  summary?: string;
  description?: string;
  location?: string;
  start: McpDateTime;
  end: McpDateTime;
}

/**
 * Converts a server event into the shared CalendarEvent model.
 * @param account Nickname of the account the event was fetched from, when multiple accounts are configured.
 */
export function toCalendarEvent(raw: unknown, account?: string): CalendarEvent {
  if (!isMcpEvent(raw)) {
    throw new Error(`Unexpected event shape from calendar MCP server: ${JSON.stringify(raw)}`);
  }

  const event: CalendarEvent = {
    id: raw.id,
    // Google allows events without a title; keep the model's title non-optional.
    title: raw.summary ?? "",
    start: parseMcpDateTime(raw.start, `${raw.id}.start`),
    end: parseMcpDateTime(raw.end, `${raw.id}.end`),
    allDay: raw.start.date !== undefined,
  };
  if (raw.description !== undefined) event.description = raw.description;
  if (raw.location !== undefined) event.location = raw.location;
  if (account !== undefined) event.account = account;
  return event;
}

/**
 * Formats a Date for the server's time arguments.
 * The server only accepts second precision, so Date#toISOString()'s milliseconds are stripped.
 */
export function toMcpDateTime(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * Formats a Date as YYYY-MM-DD in local time, which is how the server expects all-day values.
 */
export function toMcpDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * Parses a server start/end value. All-day dates become local midnight to match toMcpDate.
 */
function parseMcpDateTime(value: McpDateTime, where: string): Date {
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
 * Structural check for the fields toCalendarEvent relies on.
 */
function isMcpEvent(value: unknown): value is McpEvent {
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
