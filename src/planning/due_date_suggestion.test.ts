import { describe, expect, test } from "bun:test";
import type { CalendarEvent } from "../services/calendar";
import type { Task } from "../services/tasks";
import {
  MAX_TASKS_PER_DAY,
  WORKING_HOURS_END,
  WORKING_HOURS_START,
  computeSearchRange,
  suggestDueDate,
} from "./due_date_suggestion";

/** Fixed "now" used across tests: Friday 2026-09-25, 09:00. */
const now = new Date(2026, 8, 25, 9, 0, 0);

/**
 * The first weekday candidate after `now`: Saturday 2026-09-26 and Sunday 2026-09-27 are skipped, so the
 * earliest a candidate can fall on is Monday 2026-09-28.
 */
const firstCandidate = new Date(2026, 8, 28);

/** The next weekday candidate after firstCandidate: Tuesday 2026-09-29. */
const secondCandidate = new Date(2026, 8, 29);

/** Builds a timed event on the given day, from `startHour` to `endHour` (local time). */
function timedEvent(day: Date, startHour: number, endHour: number): CalendarEvent {
  return {
    id: `evt-${startHour}-${endHour}`,
    title: "Busy",
    start: new Date(day.getFullYear(), day.getMonth(), day.getDate(), startHour),
    end: new Date(day.getFullYear(), day.getMonth(), day.getDate(), endHour),
    allDay: false,
  };
}

/** Builds an all-day event spanning [start, end) (both local-midnight dates, end exclusive). */
function allDayEvent(start: Date, end: Date): CalendarEvent {
  return { id: "allday", title: "Trip", start, end, allDay: true };
}

/** Builds an incomplete task due on the given day. */
function taskDue(day: Date, id = "t"): Task {
  return { id, title: "Task", completed: false, due: day };
}

describe("suggestDueDate", () => {
  test("suggests the first weekday when there is no calendar/task load", () => {
    const result = suggestDueDate({ now, events: [], tasks: [] });
    expect(result).toEqual({
      date: firstCandidate,
      freeHours: WORKING_HOURS_END - WORKING_HOURS_START,
      tasksDueThatDay: 0,
    });
  });

  test("never suggests a Saturday or Sunday, even when the weekend itself is completely free", () => {
    // Saturday 2026-09-26 and Sunday 2026-09-27 have no events/tasks at all, yet the result still skips
    // straight to Monday: weekends are excluded from candidates outright, not merely deprioritized.
    const result = suggestDueDate({ now, events: [], tasks: [] });
    expect(result.date.getDay()).not.toBe(0);
    expect(result.date.getDay()).not.toBe(6);
    expect(result.date).toEqual(firstCandidate);
  });

  test("skips a day whose working hours are fully booked", () => {
    const events = [timedEvent(firstCandidate, WORKING_HOURS_START, WORKING_HOURS_END)];
    const result = suggestDueDate({ now, events, tasks: [] });
    expect(result.date).toEqual(secondCandidate);
    expect(result.freeHours).toBe(WORKING_HOURS_END - WORKING_HOURS_START);
  });

  test("skips a day blocked by an all-day event", () => {
    const events = [allDayEvent(firstCandidate, secondCandidate)];
    const result = suggestDueDate({ now, events, tasks: [] });
    expect(result.date).toEqual(secondCandidate);
  });

  test("skips a day already at the maximum existing task load", () => {
    const tasks = Array.from({ length: MAX_TASKS_PER_DAY }, (_, i) => taskDue(firstCandidate, `t${i}`));
    const result = suggestDueDate({ now, events: [], tasks });
    expect(result.date).toEqual(secondCandidate);
    expect(result.tasksDueThatDay).toBe(0);
  });

  test("does not skip a day one below the maximum existing task load (boundary)", () => {
    const tasks = Array.from({ length: MAX_TASKS_PER_DAY - 1 }, (_, i) => taskDue(firstCandidate, `t${i}`));
    const result = suggestDueDate({ now, events: [], tasks });
    expect(result.date).toEqual(firstCandidate);
    expect(result.tasksDueThatDay).toBe(MAX_TASKS_PER_DAY - 1);
  });

  test("excludes completed tasks from the day's load", () => {
    const tasks = Array.from({ length: MAX_TASKS_PER_DAY }, (_, i) => ({
      ...taskDue(firstCandidate, `t${i}`),
      completed: true,
    }));
    const result = suggestDueDate({ now, events: [], tasks });
    expect(result.date).toEqual(firstCandidate);
    expect(result.tasksDueThatDay).toBe(0);
  });

  test("accepts a day whose free hours exactly meet the estimate (boundary)", () => {
    // 7 hours booked (9-16), leaving exactly 2 hours free within the 9-18 working day.
    const events = [timedEvent(firstCandidate, WORKING_HOURS_START, 16)];
    const result = suggestDueDate({ now, events, tasks: [], estimatedHours: 2 });
    expect(result.date).toEqual(firstCandidate);
    expect(result.freeHours).toBe(2);
  });

  test("skips a day whose free hours fall just short of the estimate (boundary)", () => {
    // 7.5 hours booked (9-16:30), leaving 1.5 hours free, short of a 2-hour estimate.
    const events: CalendarEvent[] = [
      {
        id: "evt",
        title: "Busy",
        start: new Date(2026, 8, 28, WORKING_HOURS_START),
        end: new Date(2026, 8, 28, 16, 30),
        allDay: false,
      },
    ];
    const result = suggestDueDate({ now, events, tasks: [], estimatedHours: 2 });
    expect(result.date).toEqual(secondCandidate);
  });

  test("clamps an estimate exceeding a full day's working hours to that day's capacity", () => {
    // A task can never fit "more than a full day" in this single-day model; without clamping this would
    // always fall back to the last searched day regardless of how free it is.
    const dailyCapacity = WORKING_HOURS_END - WORKING_HOURS_START;
    const result = suggestDueDate({ now, events: [], tasks: [], estimatedHours: dailyCapacity + 5 });
    expect(result.date).toEqual(firstCandidate);
    expect(result.freeHours).toBe(dailyCapacity);
  });

  test("falls back to the last searched weekday when every day in range is overloaded", () => {
    // Books all 3 weekday candidates (Mon 9/28, Tue 9/29, Wed 9/30); the weekend in between is skipped and
    // does not count against searchDays.
    const events: CalendarEvent[] = [firstCandidate, secondCandidate, new Date(2026, 8, 30)].map((day) =>
      timedEvent(day, WORKING_HOURS_START, WORKING_HOURS_END),
    );
    const result = suggestDueDate({ now, events, tasks: [], searchDays: 3 });
    expect(result.date).toEqual(new Date(2026, 8, 30));
    expect(result.freeHours).toBe(0);
  });

  test("respects a custom searchDays window", () => {
    const result = suggestDueDate({ now, events: [], tasks: [], searchDays: 1 });
    expect(result.date).toEqual(firstCandidate);
  });

  test("an event outside working hours does not reduce free time", () => {
    const events = [timedEvent(firstCandidate, 6, 8)];
    const result = suggestDueDate({ now, events, tasks: [] });
    expect(result.freeHours).toBe(WORKING_HOURS_END - WORKING_HOURS_START);
  });
});

describe("computeSearchRange", () => {
  test("starts tomorrow and ends the day after the last candidate weekday", () => {
    const range = computeSearchRange(now, 1);
    expect(range).toEqual({ start: new Date(2026, 8, 26), end: new Date(2026, 8, 29) });
  });

  test("a larger searchDays extends the end further out", () => {
    const shortRange = computeSearchRange(now, 1);
    const longRange = computeSearchRange(now, 5);
    expect(longRange.start).toEqual(shortRange.start);
    expect(longRange.end.getTime()).toBeGreaterThan(shortRange.end.getTime());
  });
});
