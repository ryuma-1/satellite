import { describe, expect, test } from "bun:test";
import type { GwsCaller, GwsRequest } from "../../gws/runner";
import { GoogleCalendarAdapter } from "./adapter";
import fixture from "./fixtures/list-events.json";

/**
 * Computes a fake response from the call, so multi-account/multi-calendar tests can answer per call.
 * `paged` distinguishes call() (false) from callAllPages() (true), mirroring GwsCaller's two methods.
 */
type Responder = (account: string, req: GwsRequest, paged: boolean) => unknown;

/**
 * Records gws calls and replies with a canned or computed response.
 */
class FakeCaller implements GwsCaller {
  readonly calls: { account: string; req: GwsRequest; paged: boolean }[] = [];

  /**
   * @param response Value returned from every call, or a Responder computing it per call. For callAllPages,
   * a plain (non-array) value is wrapped as the single page `[response]`.
   */
  constructor(private readonly response: unknown) {}

  /** Records the call and returns the single-value response. */
  async call(account: string, req: GwsRequest): Promise<unknown> {
    this.calls.push({ account, req, paged: false });
    return this.respond(account, req, false);
  }

  /** Records the call and returns the response as an array of pages. */
  async callAllPages(account: string, req: GwsRequest): Promise<unknown[]> {
    this.calls.push({ account, req, paged: true });
    const result = this.respond(account, req, true);
    return Array.isArray(result) ? result : [result];
  }

  private respond(account: string, req: GwsRequest, paged: boolean): unknown {
    return typeof this.response === "function" ? (this.response as Responder)(account, req, paged) : this.response;
  }
}

const timedEvent = fixture.items[0];

describe("GoogleCalendarAdapter", () => {
  test("listEvents sends range and maps events", async () => {
    const caller = new FakeCaller(fixture);
    const adapter = new GoogleCalendarAdapter(caller, { timeZone: "Asia/Tokyo", accounts: ["acct"] });

    const events = await adapter.listEvents({
      from: new Date("2026-09-24T00:00:00.000Z"),
      to: new Date("2026-09-30T00:00:00.000Z"),
    });

    expect(caller.calls).toEqual([
      {
        account: "acct",
        paged: true,
        req: {
          path: ["calendar", "events", "list"],
          params: {
            calendarId: "primary",
            singleEvents: true,
            orderBy: "startTime",
            timeZone: "Asia/Tokyo",
            timeMin: "2026-09-24T00:00:00Z",
            timeMax: "2026-09-30T00:00:00Z",
          },
        },
      },
    ]);
    expect(events.map((e) => [e.id, e.account])).toEqual([
      ["evt_timed_001", "acct"],
      ["evt_allday_002", "acct"],
    ]);
  });

  test("listEvents omits unset optional arguments", async () => {
    const caller = new FakeCaller({ items: [] });
    await new GoogleCalendarAdapter(caller, { calendarId: "work@example.com", accounts: ["acct"] }).listEvents();
    expect(caller.calls[0]?.req.params).toEqual({
      calendarId: "work@example.com",
      singleEvents: true,
      orderBy: "startTime",
    });
  });

  test("listEvents fails loudly on unexpected response", async () => {
    const adapter = new GoogleCalendarAdapter(new FakeCaller("plain text"), { accounts: ["acct"] });
    await expect(adapter.listEvents()).rejects.toThrow('unexpected response');
  });

  test("createEvent maps title and formats timed values", async () => {
    const caller = new FakeCaller(timedEvent);
    const created = await new GoogleCalendarAdapter(caller, { accounts: ["acct"] }).createEvent({
      title: "Team sync",
      start: new Date("2026-09-24T01:00:00Z"),
      end: new Date("2026-09-24T02:00:00Z"),
      location: "Room A",
    });

    expect(caller.calls[0]).toEqual({
      account: "acct",
      paged: false,
      req: {
        path: ["calendar", "events", "insert"],
        params: { calendarId: "primary" },
        body: {
          summary: "Team sync",
          start: { dateTime: "2026-09-24T01:00:00Z" },
          end: { dateTime: "2026-09-24T02:00:00Z" },
          location: "Room A",
        },
      },
    });
    expect(created.id).toBe("evt_timed_001");
    expect(created.account).toBe("acct");
  });

  test("createEvent sends dates for all-day events", async () => {
    const caller = new FakeCaller(fixture.items[1]);
    await new GoogleCalendarAdapter(caller, { accounts: ["acct"] }).createEvent({
      title: "Holiday",
      start: new Date(2026, 8, 25),
      end: new Date(2026, 8, 26),
      allDay: true,
    });
    expect(caller.calls[0]?.req.body).toMatchObject({ start: { date: "2026-09-25" }, end: { date: "2026-09-26" } });
  });

  test("updateEvent patches only the given fields, without touching allDay shape", async () => {
    const caller = new FakeCaller(timedEvent);
    await new GoogleCalendarAdapter(caller, { accounts: ["acct"] }).updateEvent("evt_timed_001", { title: "Renamed" });
    expect(caller.calls[0]).toEqual({
      account: "acct",
      paged: false,
      req: {
        path: ["calendar", "events", "patch"],
        params: { calendarId: "primary", eventId: "evt_timed_001", sendUpdates: "none" },
        body: { summary: "Renamed" },
      },
    });
  });

  test("updateEvent switching allDay fetches the current event and replaces it wholesale, preserving " +
    "fields the adapter has no model for and stripping only the read-only ones", async () => {
    const existing = {
      kind: "calendar#event",
      etag: '"existing-etag"',
      id: "evt_timed_001",
      htmlLink: "https://calendar.google.com/event?eid=abc",
      created: "2026-01-01T00:00:00.000Z",
      updated: "2026-01-02T00:00:00.000Z",
      creator: { email: "creator@example.com" },
      organizer: { email: "organizer@example.com" },
      summary: "Team sync",
      location: "Room A",
      colorId: "5",
      attendees: [{ email: "guest@example.com" }],
      reminders: { useDefault: false, overrides: [{ method: "popup", minutes: 10 }] },
      extendedProperties: { private: { source: "satellite" } },
      start: { dateTime: "2026-09-24T01:00:00Z" },
      end: { dateTime: "2026-09-24T02:00:00Z" },
    };
    const caller = new FakeCaller((_account: string, req: GwsRequest) =>
      req.path[2] === "get" ? existing : { ...existing, start: { date: "2026-09-25" }, end: { date: "2026-09-26" } },
    );
    const updated = await new GoogleCalendarAdapter(caller, { accounts: ["acct"] }).updateEvent("evt_timed_001", {
      allDay: true,
      start: new Date(2026, 8, 25),
      end: new Date(2026, 8, 26),
    });

    expect(caller.calls[0]?.req).toEqual({
      path: ["calendar", "events", "get"],
      params: { calendarId: "primary", eventId: "evt_timed_001" },
    });
    expect(caller.calls[1]?.req).toEqual({
      path: ["calendar", "events", "update"],
      params: { calendarId: "primary", eventId: "evt_timed_001", sendUpdates: "none" },
      body: {
        // Read-only/administrative fields from the GET response must not be echoed back.
        summary: "Team sync",
        location: "Room A",
        colorId: "5",
        attendees: [{ email: "guest@example.com" }],
        reminders: { useDefault: false, overrides: [{ method: "popup", minutes: 10 }] },
        extendedProperties: { private: { source: "satellite" } },
        start: { date: "2026-09-25" },
        end: { date: "2026-09-26" },
      },
    });
    expect(updated.allDay).toBe(true);
  });

  test("updateEvent switching allDay requires both start and end", async () => {
    const adapter = new GoogleCalendarAdapter(new FakeCaller(timedEvent), { accounts: ["acct"] });
    await expect(adapter.updateEvent("e", { allDay: true })).rejects.toThrow(
      "changing allDay requires both start and end",
    );
  });

  test("updateEvent with allDay set but unchanged (no real shape change) uses a plain patch, not get+PUT", async () => {
    // update_event forwards `allDay` whenever the caller sets it at all, even when the event is already
    // timed and stays timed (e.g. `{title, allDay: false}`); that must not require both start and end.
    const caller = new FakeCaller((_account: string, req: GwsRequest) =>
      req.path[2] === "get" ? timedEvent : { ...timedEvent, summary: "Renamed" },
    );
    const updated = await new GoogleCalendarAdapter(caller, { accounts: ["acct"] }).updateEvent("evt_timed_001", {
      title: "Renamed",
      allDay: false,
    });

    expect(caller.calls).toHaveLength(2);
    expect(caller.calls[0]?.req.path).toEqual(["calendar", "events", "get"]);
    expect(caller.calls[1]?.req).toEqual({
      path: ["calendar", "events", "patch"],
      params: { calendarId: "primary", eventId: "evt_timed_001", sendUpdates: "none" },
      body: { summary: "Renamed" },
    });
    expect(updated.title).toBe("Renamed");
  });

  test("updateEvent with allDay set but unchanged for an all-day event also uses a plain patch", async () => {
    const allDayEvent = fixture.items[1]!;
    const caller = new FakeCaller((_account: string, req: GwsRequest) =>
      req.path[2] === "get" ? allDayEvent : { ...allDayEvent, summary: "Renamed" },
    );
    await new GoogleCalendarAdapter(caller, { accounts: ["acct"] }).updateEvent(allDayEvent.id, {
      title: "Renamed",
      allDay: true,
    });

    expect(caller.calls).toHaveLength(2);
    expect(caller.calls[1]?.req.path).toEqual(["calendar", "events", "patch"]);
  });

  test("updateEvent patching start/end on an unchanged all-day event sends {date}, not {dateTime}", async () => {
    const allDayEvent = fixture.items[1]!;
    const caller = new FakeCaller((_account: string, req: GwsRequest) =>
      req.path[2] === "get" ? allDayEvent : { ...allDayEvent, start: { date: "2026-10-01" }, end: { date: "2026-10-02" } },
    );
    await new GoogleCalendarAdapter(caller, { accounts: ["acct"] }).updateEvent(allDayEvent.id, {
      start: new Date(2026, 9, 1),
      end: new Date(2026, 9, 2),
      allDay: true,
    });

    expect(caller.calls).toHaveLength(2);
    expect(caller.calls[1]?.req).toEqual({
      path: ["calendar", "events", "patch"],
      params: { calendarId: "primary", eventId: allDayEvent.id, sendUpdates: "none" },
      body: { start: { date: "2026-10-01" }, end: { date: "2026-10-02" } },
    });
  });

  test("updateEvent patching start/end on an unchanged timed event sends {dateTime}, not {date}", async () => {
    const caller = new FakeCaller((_account: string, req: GwsRequest) =>
      req.path[2] === "get" ? timedEvent : { ...timedEvent, start: { dateTime: "2026-09-24T03:00:00Z" }, end: { dateTime: "2026-09-24T04:00:00Z" } },
    );
    await new GoogleCalendarAdapter(caller, { accounts: ["acct"] }).updateEvent("evt_timed_001", {
      start: new Date("2026-09-24T03:00:00Z"),
      end: new Date("2026-09-24T04:00:00Z"),
      allDay: false,
    });

    expect(caller.calls).toHaveLength(2);
    expect(caller.calls[1]?.req).toEqual({
      path: ["calendar", "events", "patch"],
      params: { calendarId: "primary", eventId: "evt_timed_001", sendUpdates: "none" },
      body: { start: { dateTime: "2026-09-24T03:00:00Z" }, end: { dateTime: "2026-09-24T04:00:00Z" } },
    });
  });

  test("deleteEvent succeeds on status=success", async () => {
    const caller = new FakeCaller({ bytes: 0, mimeType: "text/html", saved_file: "download.html", status: "success" });
    await new GoogleCalendarAdapter(caller, { accounts: ["acct"] }).deleteEvent("evt_timed_001");
    expect(caller.calls[0]).toEqual({
      account: "acct",
      paged: false,
      req: {
        path: ["calendar", "events", "delete"],
        params: { calendarId: "primary", eventId: "evt_timed_001", sendUpdates: "none" },
      },
    });
  });

  test("deleteEvent throws when status is not success", async () => {
    const adapter = new GoogleCalendarAdapter(new FakeCaller({ status: "failure" }), { accounts: ["acct"] });
    await expect(adapter.deleteEvent("x")).rejects.toThrow("unexpected response");
  });

  test("requires at least one account", () => {
    expect(() => new GoogleCalendarAdapter(new FakeCaller({}), { accounts: [] })).toThrow(
      "requires at least one account",
    );
  });
});

describe("GoogleCalendarAdapter with multiple accounts", () => {
  const accounts = ["personal", "school"];

  /** Builds a single-page list-events response with one timed event starting at the given ISO time. */
  const listResponse = (id: string, start: string, end: string) => ({
    items: [{ id, summary: id, start: { dateTime: start }, end: { dateTime: end } }],
  });

  test("listEvents queries each account and merges by start time", async () => {
    const caller = new FakeCaller((account: string) =>
      account === "personal"
        ? listResponse("p1", "2026-09-24T12:00:00Z", "2026-09-24T13:00:00Z")
        : listResponse("s1", "2026-09-24T09:00:00Z", "2026-09-24T10:00:00Z"),
    );
    const events = await new GoogleCalendarAdapter(caller, { accounts }).listEvents();

    expect(caller.calls.map((c) => [c.account, c.req.params?.calendarId])).toEqual([
      ["personal", "primary"],
      ["school", "primary"],
    ]);
    expect(events.map((e) => [e.id, e.account])).toEqual([
      ["s1", "school"],
      ["p1", "personal"],
    ]);
  });

  test("listEvents names every failing account instead of returning partial results", async () => {
    const caller = new FakeCaller((account: string) => {
      if (account === "school") throw new Error("token expired");
      return { items: [] };
    });
    await expect(new GoogleCalendarAdapter(caller, { accounts }).listEvents()).rejects.toThrow(
      "school/primary: token expired",
    );
  });

  test("createEvent defaults to the first account and tags the result", async () => {
    const caller = new FakeCaller(timedEvent);
    const created = await new GoogleCalendarAdapter(caller, { accounts }).createEvent({
      title: "x",
      start: new Date("2026-09-24T01:00:00Z"),
      end: new Date("2026-09-24T02:00:00Z"),
    });
    expect(caller.calls[0]?.account).toBe("personal");
    expect(created.account).toBe("personal");
  });

  test("createEvent honors an explicit account", async () => {
    const caller = new FakeCaller(timedEvent);
    await new GoogleCalendarAdapter(caller, { accounts }).createEvent({
      title: "x",
      start: new Date("2026-09-24T01:00:00Z"),
      end: new Date("2026-09-24T02:00:00Z"),
      account: "school",
    });
    expect(caller.calls[0]?.account).toBe("school");
  });

  test("rejects unknown accounts without calling gws", async () => {
    const caller = new FakeCaller(timedEvent);
    const adapter = new GoogleCalendarAdapter(caller, { accounts });
    await expect(adapter.updateEvent("e", { title: "x" }, "work")).rejects.toThrow('Unknown account "work"');
    expect(caller.calls).toHaveLength(0);
  });

  test("update/delete require an account when it is ambiguous", async () => {
    const adapter = new GoogleCalendarAdapter(new FakeCaller({ status: "success" }), { accounts });
    await expect(adapter.deleteEvent("e")).rejects.toThrow("An account is required");
  });

  test("update/delete target the given account", async () => {
    const caller = new FakeCaller(timedEvent);
    const updated = await new GoogleCalendarAdapter(caller, { accounts }).updateEvent("e", { title: "x" }, "school");
    expect(caller.calls[0]?.account).toBe("school");
    expect(updated.account).toBe("school");
  });

  test("update/delete use the sole account implicitly", async () => {
    const caller = new FakeCaller({ status: "success" });
    await new GoogleCalendarAdapter(caller, { accounts: ["school"] }).deleteEvent("e");
    expect(caller.calls[0]?.account).toBe("school");
  });
});

describe("GoogleCalendarAdapter with per-account calendars", () => {
  // Regression test for the cross-product bug: a calendar shared with only "school" must never be
  // requested through "normal", since Google 404s that combination and would fail the whole call.
  const perAccount = ["normal", { name: "school", calendarIds: ["nomura.laboratory@gmail.com"] }];

  /** Builds a single-page list-events response with one timed event starting at the given ISO time. */
  const listResponse = (id: string, start: string, end: string) => ({
    items: [{ id, summary: id, start: { dateTime: start }, end: { dateTime: end } }],
  });

  test("listEvents queries only each account's own calendars, never the cross product", async () => {
    const caller = new FakeCaller(() => listResponse("e", "2026-09-24T09:00:00Z", "2026-09-24T10:00:00Z"));
    await new GoogleCalendarAdapter(caller, { accounts: perAccount }).listEvents();

    expect(caller.calls.map((c) => [c.account, c.req.params?.calendarId])).toEqual([
      ["normal", "primary"],
      ["school", "primary"],
      ["school", "nomura.laboratory@gmail.com"],
    ]);
  });

  test("createEvent rejects a calendarId that belongs to a different account, before calling gws", async () => {
    const caller = new FakeCaller(timedEvent);
    const adapter = new GoogleCalendarAdapter(caller, { accounts: perAccount });
    await expect(
      adapter.createEvent({
        title: "x",
        start: new Date("2026-09-24T01:00:00Z"),
        end: new Date("2026-09-24T02:00:00Z"),
        account: "normal",
        calendarId: "nomura.laboratory@gmail.com",
      }),
    ).rejects.toThrow('Unknown calendarId "nomura.laboratory@gmail.com" for account "normal"');
    expect(caller.calls).toHaveLength(0);
  });

  test("updateEvent rejects a calendarId that belongs to a different account, before calling gws", async () => {
    const caller = new FakeCaller(timedEvent);
    const adapter = new GoogleCalendarAdapter(caller, { accounts: perAccount });
    await expect(
      adapter.updateEvent("e", { title: "x" }, "normal", "nomura.laboratory@gmail.com"),
    ).rejects.toThrow('Unknown calendarId "nomura.laboratory@gmail.com" for account "normal"');
    expect(caller.calls).toHaveLength(0);
  });

  test("deleteEvent rejects a calendarId that belongs to a different account, before calling gws", async () => {
    const caller = new FakeCaller({ status: "success" });
    const adapter = new GoogleCalendarAdapter(caller, { accounts: perAccount });
    await expect(adapter.deleteEvent("e", "normal", "nomura.laboratory@gmail.com")).rejects.toThrow(
      'Unknown calendarId "nomura.laboratory@gmail.com" for account "normal"',
    );
    expect(caller.calls).toHaveLength(0);
  });

  test("createEvent, updateEvent and deleteEvent accept a calendarId that belongs to the target account", async () => {
    const createCaller = new FakeCaller(timedEvent);
    const created = await new GoogleCalendarAdapter(createCaller, { accounts: perAccount }).createEvent({
      title: "x",
      start: new Date("2026-09-24T01:00:00Z"),
      end: new Date("2026-09-24T02:00:00Z"),
      account: "school",
      calendarId: "nomura.laboratory@gmail.com",
    });
    expect(createCaller.calls[0]?.req.params).toMatchObject({ calendarId: "nomura.laboratory@gmail.com" });
    expect(created.calendarId).toBe("nomura.laboratory@gmail.com");

    const updateCaller = new FakeCaller(timedEvent);
    const updated = await new GoogleCalendarAdapter(updateCaller, { accounts: perAccount }).updateEvent(
      "e",
      { title: "x" },
      "school",
      "nomura.laboratory@gmail.com",
    );
    expect(updateCaller.calls[0]?.req.params).toMatchObject({ calendarId: "nomura.laboratory@gmail.com" });
    expect(updated.calendarId).toBe("nomura.laboratory@gmail.com");

    const deleteCaller = new FakeCaller({ status: "success" });
    await new GoogleCalendarAdapter(deleteCaller, { accounts: perAccount }).deleteEvent(
      "e",
      "school",
      "nomura.laboratory@gmail.com",
    );
    expect(deleteCaller.calls[0]?.req.params).toMatchObject({ calendarId: "nomura.laboratory@gmail.com" });
  });
});
