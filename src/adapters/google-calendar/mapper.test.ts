import { describe, expect, test } from "bun:test";
import fixture from "./fixtures/list-events.json";
import { toCalendarEvent, toMcpDate, toMcpDateTime } from "./mapper";

describe("toCalendarEvent", () => {
  test("maps a timed event", () => {
    const event = toCalendarEvent(fixture.events[0]);
    expect(event).toEqual({
      id: "evt_timed_001",
      title: "Team sync",
      start: new Date("2026-09-24T01:00:00Z"),
      end: new Date("2026-09-24T02:00:00Z"),
      allDay: false,
      description: "Weekly sync",
      location: "Room A",
    });
  });

  test("maps an all-day event to local midnight", () => {
    const event = toCalendarEvent(fixture.events[1]);
    expect(event.allDay).toBe(true);
    expect(event.start).toEqual(new Date(2026, 8, 25));
    expect(event.end).toEqual(new Date(2026, 8, 26));
    expect(event).not.toHaveProperty("description");
  });

  test("tags the event with the given account", () => {
    expect(toCalendarEvent(fixture.events[0], "school").account).toBe("school");
    expect(toCalendarEvent(fixture.events[0])).not.toHaveProperty("account");
  });

  test("tags the event with the given calendarId", () => {
    expect(toCalendarEvent(fixture.events[0], undefined, "work@example.com").calendarId).toBe("work@example.com");
    expect(toCalendarEvent(fixture.events[0])).not.toHaveProperty("calendarId");
  });

  test("uses an empty title when summary is missing", () => {
    const event = toCalendarEvent({ id: "x", start: { date: "2026-01-01" }, end: { date: "2026-01-02" } });
    expect(event.title).toBe("");
  });

  test("rejects malformed events", () => {
    expect(() => toCalendarEvent({ summary: "no id" })).toThrow("Unexpected event shape");
    expect(() => toCalendarEvent({ id: "x", start: {}, end: {} })).toThrow("Missing dateTime/date");
    expect(() => toCalendarEvent({ id: "x", start: { dateTime: "nope" }, end: {} })).toThrow("Invalid dateTime");
  });
});

describe("toMcpDateTime", () => {
  test("strips milliseconds because the server rejects them", () => {
    expect(toMcpDateTime(new Date("2026-09-24T01:02:03.456Z"))).toBe("2026-09-24T01:02:03Z");
  });
});

describe("toMcpDate", () => {
  test("formats local date with zero padding", () => {
    expect(toMcpDate(new Date(2026, 0, 5, 23, 59))).toBe("2026-01-05");
  });
});
