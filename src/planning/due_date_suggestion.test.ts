import { describe, expect, test } from "bun:test";
import type { CalendarEvent } from "../services/calendar";
import type { Task } from "../services/tasks";
import type { WorkingHours } from "../config/schedule_config";
import { DEFAULT_ESTIMATED_HOURS, computeSearchRange, suggestDueDate } from "./due_date_suggestion";

/** Start hour of DEFAULT_WORKING_HOURS' weekday block, used when a test does not pass its own workingHours. */
const WORKING_HOURS_START = 9;

/** End hour of DEFAULT_WORKING_HOURS' weekday block, used when a test does not pass its own workingHours. */
const WORKING_HOURS_END = 18;

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

/** Builds an incomplete task due on the given day, optionally carrying an estimate marker in its notes. */
function taskDue(day: Date, id = "t", estimateHours?: number): Task {
  const notes = estimateHours !== undefined ? `[estimate: ${estimateHours}h]` : undefined;
  return { id, title: "Task", completed: false, due: day, notes };
}

describe("suggestDueDate", () => {
  test("suggests the first weekday when there is no calendar/task load", () => {
    const result = suggestDueDate({ now, events: [], tasks: [] });
    expect(result).toEqual({
      date: firstCandidate,
      freeHours: WORKING_HOURS_END - WORKING_HOURS_START,
      tasksDueThatDay: 0,
      taskHours: 0,
      remainingHours: WORKING_HOURS_END - WORKING_HOURS_START,
      fits: true,
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

  test("skips a day whose existing tasks' estimates leave too little working time", () => {
    // 9 working hours - a 5h and a 3h task = 1h left, short of a 2h estimate.
    const tasks = [taskDue(firstCandidate, "t1", 5), taskDue(firstCandidate, "t2", 3)];
    const result = suggestDueDate({ now, events: [], tasks, estimatedHours: 2 });
    expect(result.date).toEqual(secondCandidate);
    expect(result.tasksDueThatDay).toBe(0);
  });

  test("an 8h day with a 3h task accepts exactly 5h more but not more (boundary)", () => {
    const workingHours = withDay(1, [hours(9, 17)]);
    const tasks = [taskDue(firstCandidate, "t1", 3)];
    const fitting = suggestDueDate({ now, events: [], tasks, estimatedHours: 5, workingHours });
    expect(fitting).toMatchObject({ date: firstCandidate, freeHours: 8, taskHours: 3, remainingHours: 5, fits: true });
    const tooLarge = suggestDueDate({ now, events: [], tasks, estimatedHours: 5.5, workingHours });
    expect(tooLarge.date).toEqual(secondCandidate);
  });

  test("subtracts both calendar events and existing task estimates", () => {
    // 9h working - 4h meeting (9-13) - 3h task = 2h left: a 2h estimate fits, a 3h one does not.
    const events = [timedEvent(firstCandidate, 9, 13)];
    const tasks = [taskDue(firstCandidate, "t1", 3)];
    expect(suggestDueDate({ now, events, tasks, estimatedHours: 2 }).date).toEqual(firstCandidate);
    expect(suggestDueDate({ now, events, tasks, estimatedHours: 3 }).date).toEqual(secondCandidate);
  });

  test("counts an existing task without an estimate marker as DEFAULT_ESTIMATED_HOURS", () => {
    const tasks = [taskDue(firstCandidate, "t1")];
    const result = suggestDueDate({ now, events: [], tasks });
    expect(result.taskHours).toBe(DEFAULT_ESTIMATED_HOURS);
  });

  test("does not count a parent task whose subtasks are also due, to avoid charging the same work twice", () => {
    const parentTask = taskDue(firstCandidate, "parent", 6);
    const subtask = { ...taskDue(firstCandidate, "sub", 2), parent: "parent" };
    const result = suggestDueDate({ now, events: [], tasks: [parentTask, subtask] });
    expect(result.taskHours).toBe(2);
    expect(result.tasksDueThatDay).toBe(1);
  });

  test("excludes completed tasks from the day's load", () => {
    const tasks = [{ ...taskDue(firstCandidate, "t1", 9), completed: true }];
    const result = suggestDueDate({ now, events: [], tasks });
    expect(result.date).toEqual(firstCandidate);
    expect(result.tasksDueThatDay).toBe(0);
    expect(result.taskHours).toBe(0);
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
    expect(result.fits).toBe(false);
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

/** Builds a WorkingRange from whole local hours. */
function hours(start: number, end: number) {
  return { startMinutes: start * 60, endMinutes: end * 60 };
}

/** Mon-Fri 09:00-18:00 with Sat/Sun off, matching DEFAULT_WORKING_HOURS; tests override single days from it. */
const weekdays9to18: WorkingHours = [[], [hours(9, 18)], [hours(9, 18)], [hours(9, 18)], [hours(9, 18)], [hours(9, 18)], []];

/** Returns weekdays9to18 with the given Date#getDay() index replaced by `ranges`. */
function withDay(day: number, ranges: ReturnType<typeof hours>[]): WorkingHours {
  return weekdays9to18.map((r, i) => (i === day ? ranges : r));
}

describe("suggestDueDate with custom working hours", () => {
  test("does not double-count overlapping events", () => {
    // 10-12 and 11-13 together cover 3 hours (10-13), not 4.
    const events = [timedEvent(firstCandidate, 10, 12), timedEvent(firstCandidate, 11, 13)];
    const result = suggestDueDate({ now, events, tasks: [] });
    expect(result.freeHours).toBe(WORKING_HOURS_END - WORKING_HOURS_START - 3);
  });

  test("only counts time inside the day's working ranges, so an event in a break costs nothing", () => {
    const workingHours = withDay(1, [hours(9, 12), hours(13, 18)]);
    const events = [timedEvent(firstCandidate, 12, 13)];
    const result = suggestDueDate({ now, events, tasks: [], workingHours });
    expect(result).toMatchObject({ date: firstCandidate, freeHours: 8, tasksDueThatDay: 0 });
  });

  test("an event spanning a break only subtracts its working-time portions", () => {
    const workingHours = withDay(1, [hours(9, 12), hours(13, 18)]);
    const events = [timedEvent(firstCandidate, 11, 14)];
    const result = suggestDueDate({ now, events, tasks: [], workingHours });
    expect(result.freeHours).toBe(6);
  });

  test("suggests a Saturday when Saturday has working time", () => {
    const saturday = new Date(2026, 8, 26);
    const result = suggestDueDate({ now, events: [], tasks: [], workingHours: withDay(6, [hours(10, 12)]) });
    expect(result).toMatchObject({ date: saturday, freeHours: 2, tasksDueThatDay: 0 });
  });

  test("skips a weekday configured with no working time", () => {
    const result = suggestDueDate({ now, events: [], tasks: [], workingHours: withDay(1, []) });
    expect(result.date).toEqual(secondCandidate);
  });

  test("clamps an oversized estimate to the longest configured day", () => {
    // Only Saturday 10-12 is working time, so a 5-hour estimate is clamped to 2 hours and still fits there.
    const onlySaturday: WorkingHours = [[], [], [], [], [], [], [hours(10, 12)]];
    const result = suggestDueDate({ now, events: [], tasks: [], estimatedHours: 5, workingHours: onlySaturday });
    expect(result.date).toEqual(new Date(2026, 8, 26));
  });

  test("throws instead of looping forever when no day has working time", () => {
    const none: WorkingHours = [[], [], [], [], [], [], []];
    expect(() => suggestDueDate({ now, events: [], tasks: [], workingHours: none })).toThrow(/no working time/);
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

  test("follows custom working hours when choosing the last candidate day", () => {
    // Only Wednesdays have working time, so the single candidate is Wednesday 2026-09-30.
    const onlyWednesday: WorkingHours = [[], [], [], [hours(9, 18)], [], [], []];
    const range = computeSearchRange(now, 1, onlyWednesday);
    expect(range).toEqual({ start: new Date(2026, 8, 26), end: new Date(2026, 9, 1) });
  });
});
