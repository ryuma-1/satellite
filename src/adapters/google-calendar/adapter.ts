import { fanOut } from "../../gws/fan_out";
import type { GwsCaller } from "../../gws/runner";
import type {
  CalendarEvent,
  CalendarEventPatch,
  CalendarService,
  ListEventsParams,
  NewCalendarEvent,
} from "../../services/calendar";
import type { GoogleEvent } from "./mapper";
import { isGoogleEvent, toCalendarEvent, toDateOnly, toRfc3339, toTimestamp } from "./mapper";

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
  /** Account nickname; must match a gws config directory set up via `bun run src/cli/auth.ts <name>`. */
  name: string;
  /**
   * Additional calendar ids (e.g. sub or shared calendars) served alongside this account's default calendar.
   * Calendars belong to the account they are shared with, so they are only ever queried through it (a shared
   * calendar 404s when requested through a different account, see docs/spikes/gws-cli-0.22.5.md §4).
   */
  calendarIds?: string[];
}

/**
 * Options for GoogleCalendarAdapter.
 */
export interface GoogleCalendarAdapterOptions {
  /** Default target calendar within each account. Defaults to each account's primary calendar. */
  calendarId?: string;
  /** IANA time zone forwarded to gws; the calendar's default is used when omitted. */
  timeZone?: string;
  /**
   * Accounts to query, each with its own extra calendars. At least one is required (named-account mode is
   * mandatory, see the implementation plan): satellite no longer supports a single unnamed account. A plain
   * string is shorthand for an account with no extra calendars. The first account is the default for createEvent.
   */
  accounts: (string | GoogleCalendarAccount)[];
}

/**
 * CalendarService backed by the gws CLI (docs/spikes/gws-cli-0.22.5.md), spanning one or more Google accounts
 * and calendars via GwsCaller (one process per call; no persistent server, design_doc §1.4).
 */
export class GoogleCalendarAdapter implements CalendarService {
  private readonly calendarId: string;
  private readonly timeZone?: string;
  private readonly accounts: Required<GoogleCalendarAccount>[];

  /**
   * @param caller Runs gws calls for a given account.
   */
  constructor(
    private readonly caller: GwsCaller,
    options: GoogleCalendarAdapterOptions,
  ) {
    this.calendarId = options.calendarId ?? DEFAULT_CALENDAR_ID;
    this.timeZone = options.timeZone;
    this.accounts = options.accounts.map((a) =>
      typeof a === "string" ? { name: a, calendarIds: [] } : { name: a.name, calendarIds: a.calendarIds ?? [] },
    );
    if (this.accounts.length === 0) {
      throw new Error("GoogleCalendarAdapter requires at least one account");
    }
  }

  /**
   * Lists events via `calendar events list`, once per account/calendar pair, and merges them by start time.
   * Each account is only queried for its own calendars (never another account's), since a calendar shared
   * with only one account 404s when requested through any other (docs/spikes/gws-cli-0.22.5.md §4).
   */
  async listEvents(params: ListEventsParams = {}): Promise<CalendarEvent[]> {
    const targets = this.accounts.flatMap((account) =>
      [this.calendarId, ...account.calendarIds].map((calendarId) => ({ account: account.name, calendarId })),
    );
    const events = await fanOut(
      targets,
      (t) => `${t.account}/${t.calendarId}`,
      (t) => this.listEventsFor(t.account, t.calendarId, params),
    );
    return events.sort((a, b) => a.start.getTime() - b.start.getTime());
  }

  /**
   * Creates an event via `calendar events insert` in event.account/event.calendarId, or their defaults.
   */
  async createEvent(event: NewCalendarEvent): Promise<CalendarEvent> {
    const account = this.resolveAccount(event.account, this.accounts[0]!.name);
    const calendarId = this.resolveCalendarId(account, event.calendarId);
    const format = this.dateFormatter(event.allDay ?? false);
    const raw = await this.caller.call(account, {
      path: ["calendar", "events", "insert"],
      params: { calendarId },
      body: {
        summary: event.title,
        start: format(event.start),
        end: format(event.end),
        ...(event.description !== undefined && { description: event.description }),
        ...(event.location !== undefined && { location: event.location }),
      },
    });
    return this.toEvent(raw, "calendar.events.insert", account, calendarId);
  }

  /**
   * Applies a partial update and returns the updated event.
   * Fields present in `patch` are sent; the rest are left untouched, except when `patch.allDay` actually
   * flips the event's timed/all-day shape: that cannot be expressed as a partial update through gws (see
   * replaceEventShape's doc comment), so that case alone fetches the full event first and replaces it
   * wholesale. `patch.allDay` being merely present (with no real shape change, e.g. `{title, allDay: false}`
   * on an already-timed event — update_event forwards `allDay` whenever the caller sets it at all) still
   * goes through the ordinary partial patch.
   */
  async updateEvent(
    id: string,
    patch: CalendarEventPatch,
    account?: string,
    calendarId?: string,
  ): Promise<CalendarEvent> {
    const target = this.resolveAccount(account, this.soleAccount());
    const resolvedCalendarId = this.resolveCalendarId(target, calendarId);
    const raw = await this.performUpdate(target, resolvedCalendarId, id, patch);
    return this.toEvent(raw, "calendar.events.update", target, resolvedCalendarId);
  }

  /**
   * Chooses between a plain PATCH and a fetch-then-PUT depending on whether `patch` actually changes the
   * event's timed/all-day shape, fetching the current event only when `patch.allDay` is given at all (needed
   * either way to compare against the event's actual shape).
   */
  private async performUpdate(
    account: string,
    calendarId: string,
    id: string,
    patch: CalendarEventPatch,
  ): Promise<unknown> {
    if (patch.allDay === undefined) {
      // No current event is fetched here, so the shape is unknown; this matches the pre-gws behaviour of
      // treating an omitted allDay as timed (see patchEvent's doc comment).
      return this.patchEvent(account, calendarId, id, patch, false);
    }
    const current = await this.getEventForUpdate(account, calendarId, id);
    const currentlyAllDay = current.start.date !== undefined;
    if (patch.allDay === currentlyAllDay) {
      return this.patchEvent(account, calendarId, id, patch, patch.allDay);
    }
    return this.replaceEventShape(account, calendarId, id, patch, current);
  }

  /**
   * Fetches an event via `calendar events get`, for use as the basis of a full-replace PUT.
   * Narrowed to `Record<string, unknown>` in addition to GoogleEvent so replaceEventShape can carry over
   * every field of the fetched event, not just the ones GoogleEvent's type declares.
   */
  private async getEventForUpdate(
    account: string,
    calendarId: string,
    id: string,
  ): Promise<GoogleEvent & Record<string, unknown>> {
    const raw = await this.caller.call(account, {
      path: ["calendar", "events", "get"],
      params: { calendarId, eventId: id },
    });
    if (!isRecord(raw) || !isGoogleEvent(raw)) {
      throw new Error(`calendar.events.get: unexpected response for event ${id}: ${JSON.stringify(raw)}`);
    }
    return raw;
  }

  /**
   * Deletes an event via `calendar events delete`.
   */
  async deleteEvent(id: string, account?: string, calendarId?: string): Promise<void> {
    const target = this.resolveAccount(account, this.soleAccount());
    const resolvedCalendarId = this.resolveCalendarId(target, calendarId);
    const result = await this.caller.call(target, {
      path: ["calendar", "events", "delete"],
      params: {
        calendarId: resolvedCalendarId,
        eventId: id,
        // Avoid notifying guests of changes made by the assistant.
        sendUpdates: "none",
      },
    });
    // gws's delete response is not empty: Google's empty DELETE body makes gws treat it as a binary download
    // and report `{status: "success", ...}` instead of a boolean flag (docs/spikes/gws-cli-0.22.5.md §8).
    if (!isRecord(result) || result.status !== "success") {
      throw new Error(`calendar.events.delete: unexpected response for event ${id}: ${JSON.stringify(result)}`);
    }
  }

  /**
   * Sends a plain PATCH with only the fields present in `patch`. `allDay` is the event's effective shape
   * (patch.allDay when performUpdate already resolved it against the current event, otherwise false, since
   * an omitted patch.allDay is treated as timed for formatting purposes, matching pre-gws behaviour) and
   * selects `date` vs `dateTime` formatting for start/end. Safe as long as the timed/all-day shape does not
   * change: Google's PATCH merges `start`/`end` as nested objects rather than replacing them, so this must
   * never be used to switch between timed and all-day (see replaceEventShape).
   */
  private async patchEvent(
    account: string,
    calendarId: string,
    id: string,
    patch: CalendarEventPatch,
    allDay: boolean,
  ): Promise<unknown> {
    const format = this.dateFormatter(allDay);
    const body: Record<string, unknown> = {};
    if (patch.title !== undefined) body.summary = patch.title;
    if (patch.start !== undefined) body.start = format(patch.start);
    if (patch.end !== undefined) body.end = format(patch.end);
    if (patch.description !== undefined) body.description = patch.description;
    if (patch.location !== undefined) body.location = patch.location;

    return this.caller.call(account, {
      path: ["calendar", "events", "patch"],
      params: { calendarId, eventId: id, sendUpdates: "none" },
      body,
    });
  }

  /**
   * Switches an event between timed and all-day via a full PUT (`calendar events update`), carrying over
   * every field of the already-fetched `current` event that `patch` does not touch.
   *
   * gws rejects an explicit `null` used to clear the other shape's fields (its own request-body schema
   * validation fails first), and Google's PATCH merges `start`/`end` sub-objects instead of replacing them,
   * so patching just `{start: {date: ...}}` on top of a timed event leaves the old `dateTime` in place and
   * Google rejects the resulting mixed object. PUT replaces the whole resource instead, avoiding both
   * problems, but then requires the unaffected fields to be resent or Google would drop them (attendees,
   * reminders, recurrence, conferenceData, colorId, visibility, transparency, attachments,
   * extendedProperties, guestsCan*, etc.) (docs/spikes/gws-cli-0.22.5.md §8).
   */
  private async replaceEventShape(
    account: string,
    calendarId: string,
    id: string,
    patch: CalendarEventPatch,
    current: GoogleEvent & Record<string, unknown>,
  ): Promise<unknown> {
    if (patch.start === undefined || patch.end === undefined) {
      throw new Error("updateEvent: changing allDay requires both start and end");
    }

    const format = this.dateFormatter(patch.allDay === true);
    // Start from every field gws returned for the current event (minus the ones the API manages itself),
    // so fields the adapter has no model for are not silently dropped by the PUT.
    const body = stripReadOnlyEventFields(current);
    body.summary = patch.title ?? current.summary;
    body.start = format(patch.start);
    body.end = format(patch.end);
    if (patch.description !== undefined) body.description = patch.description;
    if (patch.location !== undefined) body.location = patch.location;

    return this.caller.call(account, {
      path: ["calendar", "events", "update"],
      params: { calendarId, eventId: id, sendUpdates: "none" },
      body,
    });
  }

  /**
   * Fetches and converts events for a single account/calendar pair, across every page.
   */
  private async listEventsFor(account: string, calendarId: string, params: ListEventsParams): Promise<CalendarEvent[]> {
    const pages = await this.caller.callAllPages(account, {
      path: ["calendar", "events", "list"],
      params: {
        calendarId,
        // Expand recurring events into individual instances, ordered chronologically (design_doc requirement).
        singleEvents: true,
        orderBy: "startTime",
        ...this.timeZoneArg(),
        ...(params.from && { timeMin: toTimestamp(params.from) }),
        ...(params.to && { timeMax: toTimestamp(params.to) }),
      },
    });
    const label = `${account}/${calendarId}`;
    return pages
      .flatMap((page) => expectItems(page, "calendar.events.list", label))
      .map((raw) => toCalendarEvent(raw, account, this.taggedCalendarId(calendarId)));
  }

  /**
   * Converts an insert/patch/update response into a CalendarEvent, tagging it with the account/calendar it
   * was written to (gws returns the Event resource directly, with no wrapper key).
   */
  private toEvent(raw: unknown, tool: string, account: string, calendarId: string): CalendarEvent {
    if (!isGoogleEvent(raw)) {
      throw new Error(`${tool}: unexpected response: ${JSON.stringify(raw)}`);
    }
    return toCalendarEvent(raw, account, this.taggedCalendarId(calendarId));
  }

  /**
   * Returns the start/end formatter for the given all-day flag.
   */
  private dateFormatter(allDay: boolean): (date: Date) => ReturnType<typeof toRfc3339> {
    return allDay ? toDateOnly : (date) => toRfc3339(date, this.timeZone);
  }

  /**
   * Validates a requested account against the configured list, falling back to `fallback`.
   * Throws when it cannot be determined, since guessing could modify or delete an event in the wrong account.
   */
  private resolveAccount(requested: string | undefined, fallback: string | undefined): string {
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
   * Validates a requested calendar id against the calendars available to `account`, falling back to the
   * default calendar when omitted. Throws on an id belonging to a different account (or unknown altogether),
   * since guessing could modify or delete the wrong calendar, and a calendar shared with only one account
   * 404s when requested through another.
   */
  private resolveCalendarId(account: string, requested: string | undefined): string {
    if (requested === undefined) return this.calendarId;
    const known = this.calendarsFor(account);
    if (!known.includes(requested)) {
      throw new Error(`Unknown calendarId "${requested}" for account "${account}"; configured calendars: ${known.join(", ")}`);
    }
    return requested;
  }

  /**
   * Returns the calendars available to `account` (its default plus its own extras).
   */
  private calendarsFor(account: string): string[] {
    const found = this.accounts.find((a) => a.name === account);
    return [this.calendarId, ...(found?.calendarIds ?? [])];
  }

  /**
   * Returns calendarId only when some account has extra calendars, keeping CalendarEventView minimal for the
   * common single-calendar setup.
   */
  private taggedCalendarId(calendarId: string): string | undefined {
    return this.accounts.some((a) => a.calendarIds.length > 0) ? calendarId : undefined;
  }

  /**
   * Returns the timeZone query argument only when configured, letting gws fall back to the calendar default.
   */
  private timeZoneArg(): { timeZone?: string } {
    return this.timeZone ? { timeZone: this.timeZone } : {};
  }
}

/**
 * Extracts and validates the `items` array from one page of `calendar.events.list`'s response envelope.
 */
function expectItems(page: unknown, tool: string, label: string): unknown[] {
  if (!isRecord(page) || !Array.isArray(page.items)) {
    throw new Error(`${tool}: unexpected response for ${label}: ${JSON.stringify(page)}`);
  }
  return page.items;
}

/**
 * Narrows unknown JSON values to plain objects.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Fields of Google Calendar's Event resource that the API manages itself (per `gws schema
 * calendar.events.update --resolve-refs`'s descriptions, all eight are documented "Read-only", and `kind`/
 * `etag` are resource metadata rather than event data). `id` is also excluded since it is redundant with
 * the `eventId` already sent as a query parameter. Echoing these back unmodified on a PUT is unnecessary
 * at best; everything else fetched from `calendar.events.get` is kept, so unrelated fields survive the
 * full-replace path used by replaceEventShape.
 */
const READ_ONLY_EVENT_FIELDS = ["kind", "etag", "id", "htmlLink", "created", "updated", "creator", "organizer"];

/**
 * Copies every field of a fetched Event resource except READ_ONLY_EVENT_FIELDS, as the base of a
 * full-replace PUT body (see replaceEventShape).
 */
function stripReadOnlyEventFields(event: Record<string, unknown>): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(event)) {
    if (!READ_ONLY_EVENT_FIELDS.includes(key)) {
      body[key] = value;
    }
  }
  return body;
}
