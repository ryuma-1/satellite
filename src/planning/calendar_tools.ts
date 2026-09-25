import { tool, type ToolSet } from "ai";
import { z } from "zod";
import type { CalendarEvent, CalendarEventPatch, CalendarService } from "../services/calendar";
import { formatLocalDate, formatLocalDateTime, parseDateInput } from "./datetime";

/**
 * CalendarEvent as returned to the LLM: dates become strings so the tool result is plain JSON.
 */
export interface CalendarEventView {
  /** Event id, to be passed back to update_event / delete_event. */
  id: string;
  /** Event title. */
  title: string;
  /** Local date-time with offset, or YYYY-MM-DD for all-day events. */
  start: string;
  /** Exclusive end, formatted like start. */
  end: string;
  /** True for all-day events. */
  allDay: boolean;
  /** Free-form notes. */
  description?: string;
  /** Location. */
  location?: string;
  /** Owning account nickname, when multiple accounts are configured. */
  account?: string;
}

/**
 * Converts an event into the JSON shape exposed to the LLM.
 */
export function toEventView(event: CalendarEvent): CalendarEventView {
  const format = event.allDay ? formatLocalDate : formatLocalDateTime;
  const view: CalendarEventView = {
    id: event.id,
    title: event.title,
    start: format(event.start),
    end: format(event.end),
    allDay: event.allDay,
  };
  if (event.description !== undefined) view.description = event.description;
  if (event.location !== undefined) view.location = event.location;
  if (event.account !== undefined) view.account = event.account;
  return view;
}

/**
 * Description shared by every date-time argument, so the LLM formats them consistently.
 */
const DATE_TIME_HINT = "ISO 8601 with UTC offset (e.g. 2026-09-25T15:00:00+09:00), or YYYY-MM-DD for all-day events";

/**
 * Schema shape for the optional `account` argument.
 */
type AccountShape = { account: z.ZodOptional<z.ZodEnum<Record<string, string>>> };

/**
 * Builds the optional `account` argument.
 * It is omitted entirely without configured accounts, because the adapter rejects any account in that mode.
 */
function accountShape(accounts: string[], purpose: string): AccountShape {
  if (accounts.length === 0) {
    // Typed as present so tool inputs infer `account: string | undefined`; an absent key reads as undefined.
    return {} as AccountShape;
  }
  return {
    account: z
      .enum(accounts as [string, ...string[]])
      .optional()
      .describe(purpose),
  };
}

/**
 * Wraps CalendarService as AI SDK tools (design_doc §5.3), instead of exposing the MCP server's tools directly.
 * @param accounts Account nicknames from mcp_config.json; offered to the LLM as the allowed `account` values.
 */
export function createCalendarTools(service: CalendarService, accounts: string[]): ToolSet {
  const targetAccount = accountShape(
    accounts,
    "Account that owns the event. Use the `account` value returned by list_events.",
  );

  return {
    list_events: tool({
      description:
        "List calendar events in a time range, merged across all accounts and sorted by start. " +
        "Returns event ids needed by update_event and delete_event.",
      inputSchema: z.object({
        from: z.string().optional().describe(`Only events ending after this instant. ${DATE_TIME_HINT}`),
        to: z.string().optional().describe(`Only events starting before this instant. ${DATE_TIME_HINT}`),
      }),
      execute: async ({ from, to }) => {
        const events = await service.listEvents({
          from: from !== undefined ? parseDateInput(from, "from") : undefined,
          to: to !== undefined ? parseDateInput(to, "to") : undefined,
        });
        return events.map(toEventView);
      },
    }),

    create_event: tool({
      description: "Create a calendar event and return it as stored.",
      inputSchema: z.object({
        title: z.string().describe("Event title"),
        start: z.string().describe(`Start. ${DATE_TIME_HINT}`),
        end: z
          .string()
          .describe(`End (exclusive). For an all-day event on a single day, use the following day. ${DATE_TIME_HINT}`),
        allDay: z.boolean().optional().describe("True for an all-day event; start/end are then YYYY-MM-DD"),
        description: z.string().optional().describe("Notes"),
        location: z.string().optional().describe("Location"),
        ...accountShape(accounts, `Account to create the event in. Defaults to "${accounts[0]}".`),
      }),
      execute: async (input) => {
        const event = await service.createEvent({
          title: input.title,
          start: parseDateInput(input.start, "start"),
          end: parseDateInput(input.end, "end"),
          allDay: input.allDay,
          description: input.description,
          location: input.location,
          account: input.account,
        });
        return toEventView(event);
      },
    }),

    update_event: tool({
      description:
        "Update fields of an existing event; omitted fields are left unchanged. Get the id from list_events first.",
      inputSchema: z.object({
        id: z.string().describe("Event id from list_events"),
        ...targetAccount,
        title: z.string().optional().describe("New title"),
        start: z.string().optional().describe(`New start. ${DATE_TIME_HINT}`),
        end: z.string().optional().describe(`New end (exclusive). ${DATE_TIME_HINT}`),
        allDay: z.boolean().optional().describe("Set true when start/end are YYYY-MM-DD dates"),
        description: z.string().optional().describe("New notes"),
        location: z.string().optional().describe("New location"),
      }),
      execute: async ({ id, account, ...fields }) => {
        const patch: CalendarEventPatch = {};
        if (fields.title !== undefined) patch.title = fields.title;
        if (fields.start !== undefined) patch.start = parseDateInput(fields.start, "start");
        if (fields.end !== undefined) patch.end = parseDateInput(fields.end, "end");
        if (fields.allDay !== undefined) patch.allDay = fields.allDay;
        if (fields.description !== undefined) patch.description = fields.description;
        if (fields.location !== undefined) patch.location = fields.location;
        return toEventView(await service.updateEvent(id, patch, account));
      },
    }),

    delete_event: tool({
      description: "Delete an event. Get the id from list_events first.",
      inputSchema: z.object({
        id: z.string().describe("Event id from list_events"),
        ...targetAccount,
      }),
      execute: async ({ id, account }) => {
        await service.deleteEvent(id, account);
        return { deleted: true, id };
      },
    }),
  };
}
