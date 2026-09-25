import type {
  CalendarEvent,
  CalendarEventPatch,
  CalendarService,
  ListEventsParams,
  NewCalendarEvent,
} from "../../services/calendar";
import type { McpToolCaller } from "../../mcp/client";
import { toCalendarEvent, toMcpDate, toMcpDateTime } from "./mapper";

/**
 * Options for GoogleCalendarAdapter.
 */
export interface GoogleCalendarAdapterOptions {
  /** Target calendar within each account. Defaults to each account's primary calendar. */
  calendarId?: string;
  /** IANA time zone forwarded to the server; the calendar's default is used when omitted. */
  timeZone?: string;
  /**
   * Account nicknames registered on the server (via `auth <nickname>`). The first is the default for createEvent.
   * When empty, the server's single account is used and no account argument is sent.
   */
  accounts?: string[];
}

/**
 * CalendarService backed by @cocal/google-calendar-mcp, optionally spanning multiple Google accounts.
 */
export class GoogleCalendarAdapter implements CalendarService {
  private readonly calendarId: string;
  private readonly timeZone?: string;
  private readonly accounts: string[];

  /**
   * @param caller Connection used to invoke the server's tools.
   */
  constructor(
    private readonly caller: McpToolCaller,
    options: GoogleCalendarAdapterOptions = {},
  ) {
    this.calendarId = options.calendarId ?? "primary";
    this.timeZone = options.timeZone;
    this.accounts = options.accounts ?? [];
  }

  /**
   * Lists events via the "list-events" tool, once per account, and merges them by start time.
   * The server's own multi-account merge is not used because it routes "primary" to only one account.
   */
  async listEvents(params: ListEventsParams = {}): Promise<CalendarEvent[]> {
    const targets: (string | undefined)[] = this.accounts.length > 0 ? this.accounts : [undefined];
    const results = await Promise.allSettled(targets.map((account) => this.listEventsFor(account, params)));

    const failures = results.flatMap((r, i) =>
      r.status === "rejected" ? [`${targets[i] ?? "(default)"}: ${(r.reason as Error).message}`] : [],
    );
    // Returning only the successful accounts would silently hide events, so any failure fails the whole call.
    if (failures.length > 0) {
      throw new Error(`list-events failed for ${failures.length} account(s):\n${failures.join("\n")}`);
    }

    return results
      .flatMap((r) => (r.status === "fulfilled" ? r.value : []))
      .sort((a, b) => a.start.getTime() - b.start.getTime());
  }

  /**
   * Creates an event via the "create-event" tool in event.account, or the default account.
   */
  async createEvent(event: NewCalendarEvent): Promise<CalendarEvent> {
    const account = this.resolveAccount(event.account, this.accounts[0]);
    const format = event.allDay ? toMcpDate : toMcpDateTime;
    const result = await this.caller.callTool("create-event", {
      ...this.accountArg(account),
      calendarId: this.calendarId,
      ...this.timeZoneArg(),
      summary: event.title,
      start: format(event.start),
      end: format(event.end),
      ...(event.description !== undefined && { description: event.description }),
      ...(event.location !== undefined && { location: event.location }),
    });
    return toCalendarEvent(expectField(result, "event", "create-event"), account);
  }

  /**
   * Updates an event via the "update-event" tool, sending only the fields present in the patch.
   * start/end are sent as dates only when patch.allDay is true; otherwise they are treated as timed.
   */
  async updateEvent(id: string, patch: CalendarEventPatch, account?: string): Promise<CalendarEvent> {
    const target = this.resolveAccount(account, this.soleAccount());
    const format = patch.allDay ? toMcpDate : toMcpDateTime;
    const result = await this.caller.callTool("update-event", {
      ...this.accountArg(target),
      calendarId: this.calendarId,
      eventId: id,
      ...this.timeZoneArg(),
      // The server defaults to "all", which would email every guest on changes made by the assistant.
      sendUpdates: "none",
      ...(patch.title !== undefined && { summary: patch.title }),
      ...(patch.start !== undefined && { start: format(patch.start) }),
      ...(patch.end !== undefined && { end: format(patch.end) }),
      ...(patch.description !== undefined && { description: patch.description }),
      ...(patch.location !== undefined && { location: patch.location }),
    });
    return toCalendarEvent(expectField(result, "event", "update-event"), target);
  }

  /**
   * Deletes an event via the "delete-event" tool.
   */
  async deleteEvent(id: string, account?: string): Promise<void> {
    const target = this.resolveAccount(account, this.soleAccount());
    const result = await this.caller.callTool("delete-event", {
      ...this.accountArg(target),
      calendarId: this.calendarId,
      eventId: id,
      // Same reason as updateEvent: avoid notifying guests implicitly.
      sendUpdates: "none",
    });
    if (expectField(result, "success", "delete-event") !== true) {
      throw new Error(`delete-event: server reported failure for event ${id}`);
    }
  }

  /**
   * Fetches and converts events for a single account (undefined = the server's only account).
   */
  private async listEventsFor(account: string | undefined, params: ListEventsParams): Promise<CalendarEvent[]> {
    const result = await this.caller.callTool("list-events", {
      ...this.accountArg(account),
      calendarId: this.calendarId,
      ...this.timeZoneArg(),
      ...(params.from && { timeMin: toMcpDateTime(params.from) }),
      ...(params.to && { timeMax: toMcpDateTime(params.to) }),
    });
    const events = expectField(result, "events", "list-events");
    if (!Array.isArray(events)) {
      throw new Error(`list-events: "events" is not an array`);
    }
    return events.map((raw) => toCalendarEvent(raw, account));
  }

  /**
   * Validates a requested account against the configured list, falling back to `fallback`.
   * Throws when multiple accounts are configured and none can be determined, since guessing could
   * modify or delete an event in the wrong account.
   */
  private resolveAccount(requested: string | undefined, fallback: string | undefined): string | undefined {
    if (this.accounts.length === 0) {
      if (requested !== undefined) {
        throw new Error(`Account "${requested}" was requested, but no accounts are configured`);
      }
      return undefined;
    }
    const account = requested ?? fallback;
    if (account === undefined) {
      throw new Error(`An account is required; choose one of: ${this.accounts.join(", ")}`);
    }
    if (!this.accounts.includes(account)) {
      throw new Error(`Unknown account "${account}"; configured accounts: ${this.accounts.join(", ")}`);
    }
    return account;
  }

  /**
   * Returns the only configured account, which is the only safe implicit target for update/delete.
   */
  private soleAccount(): string | undefined {
    return this.accounts.length === 1 ? this.accounts[0] : undefined;
  }

  /**
   * Returns the account argument only when an account is targeted, keeping single-account calls unchanged.
   */
  private accountArg(account: string | undefined): { account?: string } {
    return account !== undefined ? { account } : {};
  }

  /**
   * Returns the timeZone argument only when configured, letting the server fall back to the calendar default.
   */
  private timeZoneArg(): { timeZone?: string } {
    return this.timeZone ? { timeZone: this.timeZone } : {};
  }
}

/**
 * Extracts a top-level field from a tool result, failing loudly if the response shape changed.
 */
function expectField(result: unknown, field: string, tool: string): unknown {
  if (typeof result !== "object" || result === null || !(field in result)) {
    throw new Error(`${tool}: unexpected response (missing "${field}"): ${JSON.stringify(result)}`);
  }
  return (result as Record<string, unknown>)[field];
}
