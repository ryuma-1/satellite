import { describe, expect, test } from "bun:test";
import fixture from "./fixtures/list-events.json";
import { isGoogleEvent, toCalendarEvent, toDateOnly, toRfc3339, toTimestamp } from "./mapper";

describe("toCalendarEvent", () => {
  test("maps a timed event", () => {
    const event = toCalendarEvent(fixture.items[0]);
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
    const event = toCalendarEvent(fixture.items[1]);
    expect(event.allDay).toBe(true);
    expect(event.start).toEqual(new Date(2026, 8, 25));
    expect(event.end).toEqual(new Date(2026, 8, 26));
    expect(event).not.toHaveProperty("description");
  });

  test("tags the event with the given account", () => {
    expect(toCalendarEvent(fixture.items[0], "school").account).toBe("school");
    expect(toCalendarEvent(fixture.items[0])).not.toHaveProperty("account");
  });

  test("tags the event with the given calendarId", () => {
    expect(toCalendarEvent(fixture.items[0], undefined, "work@example.com").calendarId).toBe("work@example.com");
    expect(toCalendarEvent(fixture.items[0])).not.toHaveProperty("calendarId");
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

describe("isGoogleEvent", () => {
  test("accepts a minimal well-formed event", () => {
    expect(isGoogleEvent({ id: "x", start: {}, end: {} })).toBe(true);
  });

  test("rejects values missing id/start/end", () => {
    expect(isGoogleEvent({ start: {}, end: {} })).toBe(false);
    expect(isGoogleEvent({ id: "x", end: {} })).toBe(false);
    expect(isGoogleEvent("plain text")).toBe(false);
  });
});

describe("toTimestamp", () => {
  test("strips milliseconds because gws rejects sub-second precision", () => {
    expect(toTimestamp(new Date("2026-09-24T01:02:03.456Z"))).toBe("2026-09-24T01:02:03Z");
  });
});

describe("toRfc3339", () => {
  test("returns dateTime only when no time zone is configured", () => {
    expect(toRfc3339(new Date("2026-09-24T01:00:00Z"))).toEqual({ dateTime: "2026-09-24T01:00:00Z" });
  });

  test("attaches the time zone when configured", () => {
    expect(toRfc3339(new Date("2026-09-24T01:00:00Z"), "Asia/Tokyo")).toEqual({
      dateTime: "2026-09-24T01:00:00Z",
      timeZone: "Asia/Tokyo",
    });
  });
});

describe("toDateOnly", () => {
  test("formats local date with zero padding", () => {
    expect(toDateOnly(new Date(2026, 0, 5, 23, 59))).toEqual({ date: "2026-01-05" });
  });
});
