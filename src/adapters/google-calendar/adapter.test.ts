import { describe, expect, test } from "bun:test";
import type { McpToolCaller } from "../../mcp/client";
import { GoogleCalendarAdapter } from "./adapter";
import fixture from "./fixtures/list-events.json";

/**
 * Computes a fake response from the tool call, so multi-account tests can answer per account.
 */
type Responder = (name: string, args: Record<string, unknown>) => unknown;

/**
 * Records tool calls and replies with a canned or computed response.
 */
class FakeCaller implements McpToolCaller {
  readonly calls: { name: string; args: Record<string, unknown> }[] = [];

  /**
   * @param response Value returned from every call, or a Responder computing it per call.
   */
  constructor(private readonly response: unknown) {}

  /**
   * Records the call and returns the response. A thrown Responder error becomes a rejection.
   */
  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    this.calls.push({ name, args });
    return typeof this.response === "function" ? (this.response as Responder)(name, args) : this.response;
  }
}

const timedEvent = fixture.events[0];

describe("GoogleCalendarAdapter", () => {
  test("listEvents sends range and maps events", async () => {
    const caller = new FakeCaller(fixture);
    const adapter = new GoogleCalendarAdapter(caller, { timeZone: "Asia/Tokyo" });

    const events = await adapter.listEvents({
      from: new Date("2026-09-24T00:00:00.000Z"),
      to: new Date("2026-09-30T00:00:00.000Z"),
    });

    expect(caller.calls).toEqual([
      {
        name: "list-events",
        args: {
          calendarId: "primary",
          timeZone: "Asia/Tokyo",
          timeMin: "2026-09-24T00:00:00Z",
          timeMax: "2026-09-30T00:00:00Z",
        },
      },
    ]);
    expect(events.map((e) => e.id)).toEqual(["evt_timed_001", "evt_allday_002"]);
  });

  test("listEvents omits unset optional arguments", async () => {
    const caller = new FakeCaller({ events: [] });
    await new GoogleCalendarAdapter(caller, { calendarId: "work@example.com" }).listEvents();
    expect(caller.calls[0]?.args).toEqual({ calendarId: "work@example.com" });
  });

  test("listEvents fails loudly on unexpected response", async () => {
    const adapter = new GoogleCalendarAdapter(new FakeCaller("plain text"));
    await expect(adapter.listEvents()).rejects.toThrow('missing "events"');
  });

  test("createEvent maps title and formats timed values", async () => {
    const caller = new FakeCaller({ event: timedEvent });
    const created = await new GoogleCalendarAdapter(caller).createEvent({
      title: "Team sync",
      start: new Date("2026-09-24T01:00:00Z"),
      end: new Date("2026-09-24T02:00:00Z"),
      location: "Room A",
    });

    expect(caller.calls[0]).toEqual({
      name: "create-event",
      args: {
        calendarId: "primary",
        summary: "Team sync",
        start: "2026-09-24T01:00:00Z",
        end: "2026-09-24T02:00:00Z",
        location: "Room A",
      },
    });
    expect(created.id).toBe("evt_timed_001");
  });

  test("createEvent sends dates for all-day events", async () => {
    const caller = new FakeCaller({ event: fixture.events[1] });
    await new GoogleCalendarAdapter(caller).createEvent({
      title: "Holiday",
      start: new Date(2026, 8, 25),
      end: new Date(2026, 8, 26),
      allDay: true,
    });
    expect(caller.calls[0]?.args).toMatchObject({ start: "2026-09-25", end: "2026-09-26" });
  });

  test("updateEvent sends only patched fields and suppresses notifications", async () => {
    const caller = new FakeCaller({ event: timedEvent });
    await new GoogleCalendarAdapter(caller).updateEvent("evt_timed_001", { title: "Renamed" });
    expect(caller.calls[0]).toEqual({
      name: "update-event",
      args: { calendarId: "primary", eventId: "evt_timed_001", sendUpdates: "none", summary: "Renamed" },
    });
  });

  test("deleteEvent succeeds on success=true", async () => {
    const caller = new FakeCaller({ success: true, eventId: "evt_timed_001", calendarId: "primary" });
    await new GoogleCalendarAdapter(caller).deleteEvent("evt_timed_001");
    expect(caller.calls[0]).toEqual({
      name: "delete-event",
      args: { calendarId: "primary", eventId: "evt_timed_001", sendUpdates: "none" },
    });
  });

  test("deleteEvent throws on success=false", async () => {
    const adapter = new GoogleCalendarAdapter(new FakeCaller({ success: false }));
    await expect(adapter.deleteEvent("x")).rejects.toThrow("server reported failure");
  });
});

describe("GoogleCalendarAdapter with multiple accounts", () => {
  const accounts = ["personal", "school"];

  /**
   * Builds a list-events response with one timed event starting at the given ISO time.
   */
  const listResponse = (id: string, start: string, end: string) => ({
    events: [{ id, summary: id, start: { dateTime: start }, end: { dateTime: end } }],
  });

  test("listEvents queries each account and merges by start time", async () => {
    const caller = new FakeCaller((_: string, args: Record<string, unknown>) =>
      args.account === "personal"
        ? listResponse("p1", "2026-09-24T12:00:00Z", "2026-09-24T13:00:00Z")
        : listResponse("s1", "2026-09-24T09:00:00Z", "2026-09-24T10:00:00Z"),
    );
    const events = await new GoogleCalendarAdapter(caller, { accounts }).listEvents();

    expect(caller.calls.map((c) => c.args)).toEqual([
      { account: "personal", calendarId: "primary" },
      { account: "school", calendarId: "primary" },
    ]);
    expect(events.map((e) => [e.id, e.account])).toEqual([
      ["s1", "school"],
      ["p1", "personal"],
    ]);
  });

  test("listEvents names every failing account instead of returning partial results", async () => {
    const caller = new FakeCaller((_: string, args: Record<string, unknown>) => {
      if (args.account === "school") throw new Error("token expired");
      return { events: [] };
    });
    await expect(new GoogleCalendarAdapter(caller, { accounts }).listEvents()).rejects.toThrow(
      "list-events failed for 1 account(s):\nschool: token expired",
    );
  });

  test("createEvent defaults to the first account and tags the result", async () => {
    const caller = new FakeCaller({ event: timedEvent });
    const created = await new GoogleCalendarAdapter(caller, { accounts }).createEvent({
      title: "x",
      start: new Date("2026-09-24T01:00:00Z"),
      end: new Date("2026-09-24T02:00:00Z"),
    });
    expect(caller.calls[0]?.args.account).toBe("personal");
    expect(created.account).toBe("personal");
  });

  test("createEvent honors an explicit account", async () => {
    const caller = new FakeCaller({ event: timedEvent });
    await new GoogleCalendarAdapter(caller, { accounts }).createEvent({
      title: "x",
      start: new Date("2026-09-24T01:00:00Z"),
      end: new Date("2026-09-24T02:00:00Z"),
      account: "school",
    });
    expect(caller.calls[0]?.args.account).toBe("school");
  });

  test("rejects unknown accounts without calling the server", async () => {
    const caller = new FakeCaller({ event: timedEvent });
    const adapter = new GoogleCalendarAdapter(caller, { accounts });
    await expect(adapter.updateEvent("e", { title: "x" }, "work")).rejects.toThrow('Unknown account "work"');
    expect(caller.calls).toHaveLength(0);
  });

  test("update/delete require an account when it is ambiguous", async () => {
    const adapter = new GoogleCalendarAdapter(new FakeCaller({ success: true }), { accounts });
    await expect(adapter.deleteEvent("e")).rejects.toThrow("An account is required");
  });

  test("update/delete target the given account", async () => {
    const caller = new FakeCaller({ event: timedEvent });
    const updated = await new GoogleCalendarAdapter(caller, { accounts }).updateEvent("e", { title: "x" }, "school");
    expect(caller.calls[0]?.args).toMatchObject({ account: "school", eventId: "e" });
    expect(updated.account).toBe("school");
  });

  test("update/delete use the sole account implicitly", async () => {
    const caller = new FakeCaller({ success: true });
    await new GoogleCalendarAdapter(caller, { accounts: ["school"] }).deleteEvent("e");
    expect(caller.calls[0]?.args.account).toBe("school");
  });

  test("rejects an account when none are configured", async () => {
    const adapter = new GoogleCalendarAdapter(new FakeCaller({ success: true }));
    await expect(adapter.deleteEvent("e", "school")).rejects.toThrow("no accounts are configured");
  });
});
