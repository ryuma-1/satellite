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
 * Google Calendar's identifier for a user's own calendar, used as the default when calendarId is omitted.
 */
export const DEFAULT_CALENDAR_ID = "primary";

/**
 * An account and the extra calendars it owns, as configured for GoogleCalendarAdapter.
 * Defined locally (rather than imported from config) so the adapter does not depend on config types;
 * it is structurally compatible with config.AccountConfig.
 */
export interface GoogleCalendarAccount {
  /** Account nickname registered on the server (via `auth <nickname>`). */
  name: string;
  /**
   * Additional calendar ids (e.g. sub or shared calendars) served alongside this account's default calendar.
   * Calendars belong to the account they are shared with, so they are only ever queried through it.
   */
  calendarIds?: string[];
}

/**
 * Options for GoogleCalendarAdapter.
 */
export interface GoogleCalendarAdapterOptions {
  /** Default target calendar within each account. Defaults to each account's primary calendar. */
  calendarId?: string;
  /**
   * Additional calendar ids (e.g. sub or shared calendars) included alongside the default calendar.
   * Used only for the server's single unnamed account, i.e. when `accounts` is empty.
   */
  calendarIds?: string[];
  /** IANA time zone forwarded to the server; the calendar's default is used when omitted. */
  timeZone?: string;
  /**
   * Accounts registered on the server (via `auth <nickname>`), each with its own extra calendars.
   * A plain string is shorthand for an account with no extra calendars. The first account is the
   * default for createEvent. When empty, the server's single account is used and no account argument is sent.
   */
  accounts?: (string | GoogleCalendarAccount)[];
}

/**
 * CalendarService backed by @cocal/google-calendar-mcp, optionally spanning multiple Google accounts and calendars.
 */
export class GoogleCalendarAdapter implements CalendarService {
  private readonly calendarId: string;
  private readonly calendarIds: string[];
  private readonly timeZone?: string;
  private readonly accounts: Required<GoogleCalendarAccount>[];

  /**
   * @param caller Connection used to invoke the server's tools.
   */
  constructor(
    private readonly caller: McpToolCaller,
    options: GoogleCalendarAdapterOptions = {},
  ) {
    this.calendarId = options.calendarId ?? DEFAULT_CALENDAR_ID;
    this.calendarIds = options.calendarIds ?? [];
    this.timeZone = options.timeZone;
    this.accounts = (options.accounts ?? []).map((a) =>
      typeof a === "string" ? { name: a, calendarIds: [] } : { name: a.name, calendarIds: a.calendarIds ?? [] },
    );
  }

  /**
   * Lists events via the "list-events" tool, once per account/calendar pair, and merges them by start time.
   * Each account is only queried for its own calendars (never another account's), since a calendar shared
   * with only one account returns a 404 when requested through any other. The server's own multi-account
   * merge is not used because it routes "primary" to only one account.
   */
  async listEvents(params: ListEventsParams = {}): Promise<CalendarEvent[]> {
    const targets: { account: string | undefined; calendarId: string }[] =
      this.accounts.length > 0
        ? this.accounts.flatMap((account) =>
            [this.calendarId, ...account.calendarIds].map((calendarId) => ({ account: account.name, calendarId })),
          )
        : [this.calendarId, ...this.calendarIds].map((calendarId) => ({ account: undefined, calendarId }));
    const results = await Promise.allSettled(
      targets.map(({ account, calendarId }) => this.listEventsFor(account, calendarId, params)),
    );

    const failures = results.flatMap((r, i) => {
      if (r.status !== "rejected") return [];
      const target = targets[i];
      const label = target ? `${target.account ?? "(default)"}/${target.calendarId}` : `#${i}`;
      return [`${label}: ${(r.reason as Error).message}`];
    });
    // Returning only the successful account/calendar pairs would silently hide events, so any failure fails the call.
    if (failures.length > 0) {
      throw new Error(`list-events failed for ${failures.length} account/calendar pair(s):\n${failures.join("\n")}`);
    }

    return results
      .flatMap((r) => (r.status === "fulfilled" ? r.value : []))
      .sort((a, b) => a.start.getTime() - b.start.getTime());
  }

  /**
   * Creates an event via the "create-event" tool in event.account/event.calendarId, or their defaults.
   */
  async createEvent(event: NewCalendarEvent): Promise<CalendarEvent> {
    const account = this.resolveAccount(event.account, this.accounts[0]?.name);
    const calendarId = this.resolveCalendarId(account, event.calendarId);
    const format = event.allDay ? toMcpDate : toMcpDateTime;
    const result = await this.caller.callTool("create-event", {
      ...this.accountArg(account),
      calendarId,
      ...this.timeZoneArg(),
      summary: event.title,
      start: format(event.start),
      end: format(event.end),
      ...(event.description !== undefined && { description: event.description }),
      ...(event.location !== undefined && { location: event.location }),
    });
    return toCalendarEvent(expectField(result, "event", "create-event"), account, this.taggedCalendarId(calendarId));
  }

  /**
   * Updates an event via the "update-event" tool, sending only the fields present in the patch.
   * start/end are sent as dates only when patch.allDay is true; otherwise they are treated as timed.
   */
  async updateEvent(
    id: string,
    patch: CalendarEventPatch,
    account?: string,
    calendarId?: string,
  ): Promise<CalendarEvent> {
    const target = this.resolveAccount(account, this.soleAccount());
    const resolvedCalendarId = this.resolveCalendarId(target, calendarId);
    const format = patch.allDay ? toMcpDate : toMcpDateTime;
    const result = await this.caller.callTool("update-event", {
      ...this.accountArg(target),
      calendarId: resolvedCalendarId,
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
    return toCalendarEvent(
      expectField(result, "event", "update-event"),
      target,
      this.taggedCalendarId(resolvedCalendarId),
    );
  }

  /**
   * Deletes an event via the "delete-event" tool.
   */
  async deleteEvent(id: string, account?: string, calendarId?: string): Promise<void> {
    const target = this.resolveAccount(account, this.soleAccount());
    const resolvedCalendarId = this.resolveCalendarId(target, calendarId);
    const result = await this.caller.callTool("delete-event", {
      ...this.accountArg(target),
      calendarId: resolvedCalendarId,
      eventId: id,
      // Same reason as updateEvent: avoid notifying guests implicitly.
      sendUpdates: "none",
    });
    if (expectField(result, "success", "delete-event") !== true) {
      throw new Error(`delete-event: server reported failure for event ${id}`);
    }
  }

  /**
   * Fetches and converts events for a single account/calendar pair (account undefined = the server's only account).
   */
  private async listEventsFor(
    account: string | undefined,
    calendarId: string,
    params: ListEventsParams,
  ): Promise<CalendarEvent[]> {
    const result = await this.caller.callTool("list-events", {
      ...this.accountArg(account),
      calendarId,
      ...this.timeZoneArg(),
      ...(params.from && { timeMin: toMcpDateTime(params.from) }),
      ...(params.to && { timeMax: toMcpDateTime(params.to) }),
    });
    const events = expectField(result, "events", "list-events");
    if (!Array.isArray(events)) {
      throw new Error(`list-events: "events" is not an array`);
    }
    return events.map((raw) => toCalendarEvent(raw, account, this.taggedCalendarId(calendarId)));
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
    const accountNames = this.accounts.map((a) => a.name);
    if (account === undefined) {
      throw new Error(`An account is required; choose one of: ${accountNames.join(", ")}`);
    }
    if (!accountNames.includes(account)) {
      throw new Error(`Unknown account "${account}"; configured accounts: ${accountNames.join(", ")}`);
    }
    return account;
  }

  /**
   * Returns the only configured account, which is the only safe implicit target for update/delete.
   */
  private soleAccount(): string | undefined {
    return this.accounts.length === 1 ? this.accounts[0]!.name : undefined;
  }

  /**
   * Validates a requested calendar id against the calendars available to `account` (or, in unnamed mode,
   * against the unnamed calendar list), falling back to the default calendar when omitted. Throws on an id
   * belonging to a different account (or unknown altogether), since guessing could modify or delete the
   * wrong calendar, and a calendar shared with only one account 404s when requested through another.
   */
  private resolveCalendarId(account: string | undefined, requested: string | undefined): string {
    if (requested === undefined) return this.calendarId;
    const known = this.calendarsFor(account);
    if (!known.includes(requested)) {
      const scope = account !== undefined ? `account "${account}"` : "the configured account";
      throw new Error(`Unknown calendarId "${requested}" for ${scope}; configured calendars: ${known.join(", ")}`);
    }
    return requested;
  }

  /**
   * Returns the calendars available to `account` (its default plus its own extras), or, in unnamed mode,
   * the default plus the unnamed extra calendars.
   */
  private calendarsFor(account: string | undefined): string[] {
    if (this.accounts.length === 0) {
      return [this.calendarId, ...this.calendarIds];
    }
    const found = this.accounts.find((a) => a.name === account);
    return [this.calendarId, ...(found?.calendarIds ?? [])];
  }

  /**
   * Returns calendarId only when some account (or, in unnamed mode, the unnamed config) has extra calendars,
   * keeping CalendarEventView minimal for the common single-calendar setup, mirroring how account is only
   * tagged when accounts are configured.
   */
  private taggedCalendarId(calendarId: string): string | undefined {
    const hasExtraCalendars =
      this.accounts.length > 0
        ? this.accounts.some((a) => a.calendarIds.length > 0)
        : this.calendarIds.length > 0;
    return hasExtraCalendars ? calendarId : undefined;
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
