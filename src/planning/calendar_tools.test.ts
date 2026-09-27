import { describe, expect, test } from "bun:test";
import type { ToolExecutionOptions } from "ai";
import { z } from "zod";
import type {
  CalendarEvent,
  CalendarEventPatch,
  CalendarService,
  ListEventsParams,
  NewCalendarEvent,
} from "../services/calendar";
import { createCalendarTools, resolveCalendarIds, toEventView } from "./calendar_tools";

/**
 * Records service calls and replies with a fixed event, mirroring FakeCaller in adapter.test.ts.
 */
class FakeCalendar implements CalendarService {
  readonly calls: { method: string; args: unknown[] }[] = [];

  /**
   * @param event Event returned from every list/create/update call.
   */
  constructor(private readonly event: CalendarEvent) {}

  /** Records the call and returns the canned event. */
  async listEvents(params?: ListEventsParams): Promise<CalendarEvent[]> {
    this.calls.push({ method: "listEvents", args: [params] });
    return [this.event];
  }

  /** Records the call and returns the canned event. */
  async createEvent(event: NewCalendarEvent): Promise<CalendarEvent> {
    this.calls.push({ method: "createEvent", args: [event] });
    return this.event;
  }

  /** Records the call and returns the canned event. */
  async updateEvent(id: string, patch: CalendarEventPatch, account?: string, calendarId?: string): Promise<CalendarEvent> {
    this.calls.push({ method: "updateEvent", args: [id, patch, account, calendarId] });
    return this.event;
  }

  /** Records the call. */
  async deleteEvent(id: string, account?: string, calendarId?: string): Promise<void> {
    this.calls.push({ method: "deleteEvent", args: [id, account, calendarId] });
  }
}

const timedEvent: CalendarEvent = {
  id: "evt1",
  title: "Meeting",
  start: new Date(2026, 8, 25, 15, 0, 0),
  end: new Date(2026, 8, 25, 16, 0, 0),
  allDay: false,
  location: "Room A",
  account: "personal",
};

/**
 * Minimal execution options; the tools under test do not use them.
 */
const execOptions = { toolCallId: "call1", messages: [] } as unknown as ToolExecutionOptions<never>;

/**
 * Invokes a tool's execute function, failing the test if the tool has none.
 */
async function run(tools: ReturnType<typeof createCalendarTools>, name: string, input: unknown): Promise<unknown> {
  const execute = tools[name]?.execute;
  if (!execute) throw new Error(`tool ${name} has no execute`);
  return await execute(input as never, execOptions);
}

describe("toEventView", () => {
  test("formats timed events with local offset", () => {
    const view = toEventView(timedEvent);
    expect(new Date(view.start).getTime()).toBe(timedEvent.start.getTime());
    expect(view.start).toMatch(/^2026-09-25T15:00:00[+-]\d{2}:\d{2}$/);
    expect(view).toMatchObject({ id: "evt1", title: "Meeting", allDay: false, location: "Room A", account: "personal" });
    expect(view).not.toHaveProperty("description");
  });

  test("formats all-day events as dates", () => {
    const view = toEventView({
      ...timedEvent,
      allDay: true,
      start: new Date(2026, 8, 25),
      end: new Date(2026, 8, 26),
    });
    expect(view.start).toBe("2026-09-25");
    expect(view.end).toBe("2026-09-26");
  });
});

describe("createCalendarTools", () => {
  test("list_events parses the range and returns views", async () => {
    const calendar = new FakeCalendar(timedEvent);
    const tools = createCalendarTools(calendar, [], []);

    const result = await run(tools, "list_events", {
      from: "2026-09-25T00:00:00+09:00",
      to: "2026-10-01",
    });

    const params = calendar.calls[0]?.args[0] as ListEventsParams;
    expect(params.from?.toISOString()).toBe("2026-09-24T15:00:00.000Z");
    // Date-only input is local midnight, like the calendar mapper.
    expect(params.to?.getTime()).toBe(new Date(2026, 9, 1).getTime());
    expect(result).toEqual([toEventView(timedEvent)]);
  });

  test("list_events without a range passes undefined bounds", async () => {
    const calendar = new FakeCalendar(timedEvent);
    await run(createCalendarTools(calendar, [], []), "list_events", {});
    expect(calendar.calls[0]?.args[0]).toEqual({ from: undefined, to: undefined });
  });

  test("rejects unparseable dates with a message the LLM can act on", async () => {
    const calendar = new FakeCalendar(timedEvent);
    const tools = createCalendarTools(calendar, [], []);
    await expect(run(tools, "list_events", { from: "next friday" })).rejects.toThrow(/from.*ISO 8601/);
    expect(calendar.calls).toHaveLength(0);
  });

  test("create_event converts dates and forwards the account", async () => {
    const calendar = new FakeCalendar(timedEvent);
    const tools = createCalendarTools(calendar, ["personal", "school"], []);

    await run(tools, "create_event", {
      title: "Lunch",
      start: "2026-09-26T12:00:00+09:00",
      end: "2026-09-26T13:00:00+09:00",
      account: "school",
    });

    const created = calendar.calls[0]?.args[0] as NewCalendarEvent;
    expect(created.title).toBe("Lunch");
    expect(created.start.toISOString()).toBe("2026-09-26T03:00:00.000Z");
    expect(created.end.toISOString()).toBe("2026-09-26T04:00:00.000Z");
    expect(created.account).toBe("school");
  });

  test("create_event forwards the calendarId", async () => {
    const calendar = new FakeCalendar(timedEvent);
    const tools = createCalendarTools(calendar, [], ["primary", "work@example.com"]);

    await run(tools, "create_event", {
      title: "Lunch",
      start: "2026-09-26T12:00:00+09:00",
      end: "2026-09-26T13:00:00+09:00",
      calendarId: "work@example.com",
    });

    const created = calendar.calls[0]?.args[0] as NewCalendarEvent;
    expect(created.calendarId).toBe("work@example.com");
  });

  test("update_event sends only the provided fields", async () => {
    const calendar = new FakeCalendar(timedEvent);
    const tools = createCalendarTools(calendar, ["personal"], []);

    await run(tools, "update_event", { id: "evt1", account: "personal", start: "2026-09-25T16:00:00+09:00" });

    const [id, patch, account] = calendar.calls[0]?.args ?? [];
    expect(id).toBe("evt1");
    expect(account).toBe("personal");
    expect(Object.keys(patch as object)).toEqual(["start"]);
    expect((patch as CalendarEventPatch).start?.toISOString()).toBe("2026-09-25T07:00:00.000Z");
  });

  test("update_event forwards the calendarId", async () => {
    const calendar = new FakeCalendar(timedEvent);
    const tools = createCalendarTools(calendar, [], ["primary", "work@example.com"]);

    await run(tools, "update_event", { id: "evt1", calendarId: "work@example.com", title: "Renamed" });

    const [, , , calendarId] = calendar.calls[0]?.args ?? [];
    expect(calendarId).toBe("work@example.com");
  });

  test("delete_event forwards id and account", async () => {
    const calendar = new FakeCalendar(timedEvent);
    const result = await run(createCalendarTools(calendar, ["personal"], []), "delete_event", {
      id: "evt1",
      account: "personal",
    });
    expect(calendar.calls[0]).toEqual({ method: "deleteEvent", args: ["evt1", "personal", undefined] });
    expect(result).toEqual({ deleted: true, id: "evt1" });
  });

  test("delete_event forwards the calendarId", async () => {
    const calendar = new FakeCalendar(timedEvent);
    const tools = createCalendarTools(calendar, [], ["primary", "work@example.com"]);
    await run(tools, "delete_event", { id: "evt1", calendarId: "work@example.com" });
    expect(calendar.calls[0]).toEqual({ method: "deleteEvent", args: ["evt1", undefined, "work@example.com"] });
  });

  test("account argument is offered only when accounts are configured", () => {
    const propertiesOf = (accounts: string[]) => {
      const schema = createCalendarTools(new FakeCalendar(timedEvent), accounts, []).delete_event?.inputSchema;
      return (z.toJSONSchema(schema as z.ZodType) as { properties: Record<string, unknown> }).properties;
    };
    expect(propertiesOf([])).not.toHaveProperty("account");
    expect(propertiesOf(["personal", "school"]).account).toMatchObject({ enum: ["personal", "school"] });
  });

  test("calendarId argument is offered only when more than the default calendar is configured", () => {
    const propertiesOf = (calendarIds: string[]) => {
      const schema = createCalendarTools(new FakeCalendar(timedEvent), [], calendarIds).delete_event?.inputSchema;
      return (z.toJSONSchema(schema as z.ZodType) as { properties: Record<string, unknown> }).properties;
    };
    expect(propertiesOf([])).not.toHaveProperty("calendarId");
    expect(propertiesOf(["primary"])).not.toHaveProperty("calendarId");
    expect(propertiesOf(["primary", "work@example.com"]).calendarId).toMatchObject({
      enum: ["primary", "work@example.com"],
    });
  });
});

describe("resolveCalendarIds", () => {
  test("unions the default calendar with every account's calendar ids", () => {
    const ids = resolveCalendarIds(
      [
        { name: "personal", calendarIds: ["work@example.com"] },
        { name: "school", calendarIds: ["nomura.laboratory@gmail.com"] },
      ],
      "primary",
    );
    expect(ids).toEqual(["primary", "work@example.com", "nomura.laboratory@gmail.com"]);
  });

  test("de-duplicates a calendar id shared by two accounts", () => {
    const ids = resolveCalendarIds(
      [
        { name: "personal", calendarIds: ["shared@example.com"] },
        { name: "school", calendarIds: ["shared@example.com"] },
      ],
      "primary",
    );
    expect(ids).toEqual(["primary", "shared@example.com"]);
  });

  test("returns just the default calendar when no account has extras", () => {
    const ids = resolveCalendarIds([{ name: "personal", calendarIds: [] }], "primary");
    expect(ids).toEqual(["primary"]);
  });

  test("the resulting calendarId enum offered to the LLM contains the union", () => {
    const calendarIds = resolveCalendarIds(
      [
        { name: "personal", calendarIds: ["work@example.com"] },
        { name: "school", calendarIds: ["nomura.laboratory@gmail.com"] },
      ],
      "primary",
    );
    const schema = createCalendarTools(new FakeCalendar(timedEvent), ["personal", "school"], calendarIds).delete_event
      ?.inputSchema;
    const properties = (z.toJSONSchema(schema as z.ZodType) as { properties: Record<string, unknown> }).properties;
    expect(properties.calendarId).toMatchObject({
      enum: ["primary", "work@example.com", "nomura.laboratory@gmail.com"],
    });
  });
});
