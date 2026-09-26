/**
 * A calendar event in the service-independent model shared by all calendar adapters.
 */
export interface CalendarEvent {
  /** Identifier assigned by the backing calendar service. */
  id: string;
  /** Human-readable title of the event. */
  title: string;
  /** Start of the event. For all-day events this is local midnight of the first day. */
  start: Date;
  /** End of the event (exclusive). For all-day events this is local midnight of the day after the last day. */
  end: Date;
  /** True when the event spans whole days rather than specific times. */
  allDay: boolean;
  /** Free-form notes attached to the event. */
  description?: string;
  /** Location of the event. */
  location?: string;
  /**
   * Nickname of the account the event belongs to (e.g. "personal", "school").
   * Undefined when the service is not configured with multiple accounts.
   */
  account?: string;
  /**
   * Id of the calendar the event belongs to (e.g. a sub or shared calendar).
   * Undefined when the service is only configured with its default calendar.
   */
  calendarId?: string;
}

/**
 * Input for creating an event. `allDay` defaults to false; `account` defaults to the service's default account;
 * `calendarId` defaults to the service's default calendar.
 */
export type NewCalendarEvent = Omit<CalendarEvent, "id" | "allDay"> & { allDay?: boolean };

/**
 * Fields that can be changed on an existing event. The owning account and calendar cannot be changed by an update;
 * use `calendarId` on `updateEvent` only to locate the event, not to move it.
 */
export type CalendarEventPatch = Partial<Omit<CalendarEvent, "id" | "account" | "calendarId">>;

/**
 * Filter for listing events. Both bounds are optional so callers can query open-ended ranges.
 */
export interface ListEventsParams {
  /** Only events ending after this instant are returned. */
  from?: Date;
  /** Only events starting before this instant are returned. */
  to?: Date;
}

/**
 * Low-level CRUD operations over a calendar, exposed to the LLM as tools (see design_doc §3.2).
 */
export interface CalendarService {
  /** Lists events within the given range, merged across all accounts and sorted by start. */
  listEvents(params?: ListEventsParams): Promise<CalendarEvent[]>;
  /** Creates an event and returns it as stored by the service. */
  createEvent(event: NewCalendarEvent): Promise<CalendarEvent>;
  /**
   * Applies a partial update and returns the updated event.
   * `account`/`calendarId` should be the values from the listed event; event ids are only unique within an
   * account/calendar pair.
   */
  updateEvent(id: string, patch: CalendarEventPatch, account?: string, calendarId?: string): Promise<CalendarEvent>;
  /** Deletes the event with the given id. `account`/`calendarId` have the same meaning as in updateEvent. */
  deleteEvent(id: string, account?: string, calendarId?: string): Promise<void>;
}
