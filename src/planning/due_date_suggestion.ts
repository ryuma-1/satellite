import { DEFAULT_WORKING_HOURS, type WorkingHours, type WorkingRange } from "../config/schedule_config";
import type { CalendarEvent } from "../services/calendar";
import type { Task } from "../services/tasks";
import { parseEstimateHours } from "./task_estimate";

/**
 * Estimated hours a task takes when no estimate is known: used both for a new task whose caller gives none,
 * and for an existing task whose notes carry no estimate marker (see task_estimate.ts).
 */
export const DEFAULT_ESTIMATED_HOURS = 1;

/**
 * Milliseconds per hour, for converting interval durations into the hours reported to callers.
 */
const MS_PER_HOUR = 60 * 60 * 1000;

/**
 * One contiguous free interval on a candidate day, as millisecond timestamps (half-open, [start, end)).
 */
type Interval = [start: number, end: number];

/**
 * Inputs for findFreeSlot.
 */
export interface FindFreeSlotInput {
  /** Current time; the search starts the day after this. */
  now: Date;
  /** Deadline the new task must be scheduled by; only working days up to and including this day are searched. */
  deadline: Date;
  /** Existing calendar events, used to compute each candidate day's free intervals. */
  events: CalendarEvent[];
  /**
   * Existing tasks, used to compute each candidate day's task load: each incomplete task due that day
   * consumes its estimated hours (from its notes' estimate marker, or DEFAULT_ESTIMATED_HOURS).
   */
  tasks: Task[];
  /** Estimated hours the new task will take; defaults to DEFAULT_ESTIMATED_HOURS. */
  estimatedHours?: number;
  /** The user's working time per weekday (schedule_config.json); defaults to DEFAULT_WORKING_HOURS. */
  workingHours?: WorkingHours;
}

/**
 * A candidate day with room for a new task, plus the numbers behind why it was chosen, so callers (and the
 * LLM) can explain the suggestion to the user instead of presenting a bare date.
 */
export interface FreeSlotSuggestion {
  /** Candidate date, as local midnight. This is what gets saved as the task's due date. */
  date: Date;
  /**
   * Start of the first free interval on `date` long enough for the new task's estimate, after existing
   * tasks' hours are reserved from the front of the day (see findFreeSlot's doc comment). Reference display
   * only: never persisted, since Google Tasks due dates carry no time-of-day.
   */
  slotStart: Date;
  /** Free hours within working hours on that day, after subtracting overlapping calendar events. */
  freeHours: number;
  /** Number of existing, incomplete tasks already due that day. */
  tasksDueThatDay: number;
  /** Total estimated hours of those existing tasks. */
  taskHours: number;
  /** Hours still available for new work that day: freeHours minus taskHours, never below 0. */
  remainingHours: number;
  /**
   * True when a single free interval at least as long as the new task's estimate remains after reserving
   * existing tasks' hours. False only for the fallback candidate returned when no day up to the deadline has
   * room, so callers can tell the user it does not fit.
   */
  fits: boolean;
}

/**
 * Finds the earliest working day, up to a deadline, with a free interval long enough for a new task
 * (design_doc §3.2: calculations the code can guarantee should not be left to the LLM). This is a
 * lightweight, dependency-free stand-in for a real scheduling optimizer (Timefold Solver was considered and
 * rejected as overkill for suggesting a single task's due date; see the implementation plan's risk notes).
 *
 * Only working time counts as capacity: free time and sleep outside the configured working hours are never
 * scheduled into. Walks forward working day by working day, starting tomorrow and stopping at `deadline`
 * (skipping days with no working time), and for each day:
 * 1. Computes the day's free intervals within working hours, after subtracting calendar events.
 * 2. Reserves the estimated hours of existing tasks already due that day from the *front* of those free
 *    intervals (an approximation: existing tasks are assumed to be worked on first thing, back-to-back, not
 *    spread across the day — see the implementation plan's risk notes on this being a deliberate
 *    simplification, justified by `slotStart` being reference display only and never persisted).
 * 3. Returns the first remaining interval at least as long as the new task's estimate, if any; its start is
 *    `slotStart`.
 * The first day with such an interval is returned. If no day up to the deadline has one, the last day
 * searched is returned anyway with `fits: false`: suggesting nothing would be less useful than a tight but
 * explainable candidate, and the confirmation Hook (write_confirmation_hook.ts) still lets the user reject it.
 */
export function findFreeSlot(input: FindFreeSlotInput): FreeSlotSuggestion {
  const workingHours = input.workingHours ?? DEFAULT_WORKING_HOURS;
  const estimatedHours = input.estimatedHours ?? DEFAULT_ESTIMATED_HOURS;
  const estimatedMs = estimatedHours * MS_PER_HOUR;
  const today = startOfDay(input.now);
  const deadlineDay = startOfDay(input.deadline);
  // A parent task split into subtasks is represented by those subtasks' own estimates; counting the parent
  // as well would charge the same work twice.
  const parentIds = new Set(input.tasks.flatMap((t) => (t.parent !== undefined ? [t.parent] : [])));
  const countedTasks = input.tasks.filter((t) => !parentIds.has(t.id));

  const days = candidateDaysUntil(today, deadlineDay, workingHours);
  if (days.length === 0) {
    // With a deadline before tomorrow (or no working day between tomorrow and the deadline), there is no
    // candidate day to return even as a fallback, so this cannot be represented as a FreeSlotSuggestion at
    // all: the caller must catch this and surface a friendly message instead.
    throw new Error("no working day between tomorrow and the deadline");
  }

  let lastCandidate: FreeSlotSuggestion | undefined;
  for (const date of days) {
    const dueTasks = tasksDueOn(date, countedTasks);
    const taskHours = dueTasks.reduce((sum, t) => sum + (parseEstimateHours(t.notes) ?? DEFAULT_ESTIMATED_HOURS), 0);

    const freeIntervals = freeIntervalsOn(date, workingHours[date.getDay()]!, input.events);
    const freeHours = totalHours(freeIntervals);
    const remainingHours = Math.max(freeHours - taskHours, 0);
    const remainingIntervals = reserveFromFront(freeIntervals, taskHours * MS_PER_HOUR);

    const fitInterval = remainingIntervals.find(([start, end]) => end - start >= estimatedMs);
    const candidate: FreeSlotSuggestion = {
      date,
      slotStart: new Date(fitInterval?.[0] ?? fallbackSlotStart(date, remainingIntervals, workingHours[date.getDay()]!)),
      freeHours,
      tasksDueThatDay: dueTasks.length,
      taskHours,
      remainingHours,
      fits: fitInterval !== undefined,
    };
    if (candidate.fits) {
      return candidate;
    }
    lastCandidate = candidate;
  }
  // days.length > 0 was checked above, so the loop always runs at least once and this is always set.
  return lastCandidate!;
}

/**
 * Computes the calendar-day range findFreeSlot can possibly draw a candidate from, between tomorrow and
 * `deadline`, so callers that fetch calendar events/tasks to pass in (task_tools.ts's find_free_slot) can
 * bound that fetch to exactly the days this module can use, instead of pulling a user's entire event/task
 * history.
 * @returns `start`: local midnight of tomorrow, the earliest day a candidate can fall on. `end`: local
 * midnight of the day after `deadline`'s day (exclusive), matching ListEventsParams.to /
 * ListTasksParams.dueBefore's exclusive-upper-bound semantics.
 */
export function computeFreeSlotRange(now: Date, deadline: Date): { start: Date; end: Date } {
  return { start: addDays(startOfDay(now), 1), end: addDays(startOfDay(deadline), 1) };
}

/**
 * True when at least one working day exists between tomorrow and `deadline` (inclusive), i.e. whether
 * findFreeSlot has any candidate day to search rather than throwing. Callers that fetch calendar
 * events/tasks before calling findFreeSlot (task_tools.ts's find_free_slot) should check this first, so a
 * deadline of today/the past does not reach the Google Calendar API as an invalid (timeMin >= timeMax) range.
 */
export function hasCandidateWorkingDay(now: Date, deadline: Date, workingHours: WorkingHours): boolean {
  return candidateDaysUntil(startOfDay(now), startOfDay(deadline), workingHours).length > 0;
}

/**
 * Returns the working days from the day after `today` up to and including `deadlineDay`, in order, skipping
 * days off. Empty when `deadlineDay` falls before tomorrow, or when every day in that range is a day off.
 */
function candidateDaysUntil(today: Date, deadlineDay: Date, workingHours: WorkingHours): Date[] {
  const days: Date[] = [];
  for (let date = addDays(today, 1); date.getTime() <= deadlineDay.getTime(); date = addDays(date, 1)) {
    if (workingHours[date.getDay()]!.length > 0) days.push(date);
  }
  return days;
}

/**
 * Computes the free intervals within `ranges` (the day's working time) on `day`, after subtracting time
 * covered by `events`. Events are merged into disjoint busy intervals first, so overlapping events (e.g. the
 * same meeting on two calendars) are not subtracted twice.
 * An all-day event spanning `day` blocks the entire working day (no free intervals at all), on the
 * assumption that a full-day commitment (e.g. travel) leaves no realistic capacity for other work that day.
 */
function freeIntervalsOn(day: Date, ranges: readonly WorkingRange[], events: CalendarEvent[]): Interval[] {
  const timed: Interval[] = [];
  for (const event of events) {
    if (event.allDay) {
      if (day.getTime() >= event.start.getTime() && day.getTime() < event.end.getTime()) {
        return [];
      }
      continue;
    }
    timed.push([event.start.getTime(), event.end.getTime()]);
  }
  const busy = mergeIntervals(timed);

  const free: Interval[] = [];
  for (const range of ranges) {
    const rangeStart = atMinutes(day, range.startMinutes).getTime();
    const rangeEnd = atMinutes(day, range.endMinutes).getTime();
    let cursor = rangeStart;
    for (const [busyStart, busyEnd] of busy) {
      if (busyEnd <= cursor || busyStart >= rangeEnd) continue;
      if (busyStart > cursor) free.push([cursor, Math.min(busyStart, rangeEnd)]);
      cursor = Math.max(cursor, busyEnd);
      if (cursor >= rangeEnd) break;
    }
    if (cursor < rangeEnd) free.push([cursor, rangeEnd]);
  }
  return free;
}

/**
 * Consumes `ms` from the front of `intervals`, in order, dropping intervals it fully covers and trimming the
 * one it partially covers. Models "existing tasks are worked on first thing, back-to-back" (see findFreeSlot's
 * doc comment on why this approximation is acceptable here).
 */
function reserveFromFront(intervals: Interval[], ms: number): Interval[] {
  const remaining: Interval[] = [];
  let toConsume = ms;
  for (const [start, end] of intervals) {
    const length = end - start;
    if (toConsume >= length) {
      toConsume -= length;
      continue;
    }
    remaining.push([start + toConsume, end]);
    toConsume = 0;
  }
  return remaining;
}

/**
 * Reference `slotStart` for a candidate day with no interval long enough for the new task (`fits: false`):
 * the start of whatever free time is left, or, if none is left at all, the day's own first working range —
 * still a useful anchor for the confirmation display even though the day does not actually fit the task.
 */
function fallbackSlotStart(day: Date, remaining: Interval[], ranges: readonly WorkingRange[]): number {
  if (remaining.length > 0) return remaining[0]![0];
  if (ranges.length > 0) return atMinutes(day, ranges[0]!.startMinutes).getTime();
  return day.getTime();
}

/**
 * Total duration of `intervals`, in hours.
 */
function totalHours(intervals: Interval[]): number {
  return intervals.reduce((sum, [start, end]) => sum + (end - start), 0) / MS_PER_HOUR;
}

/**
 * Merges [start, end) millisecond intervals into sorted, disjoint intervals.
 */
function mergeIntervals(intervals: Interval[]): Interval[] {
  const sorted = intervals.filter(([s, e]) => e > s).sort((a, b) => a[0] - b[0]);
  const merged: Interval[] = [];
  for (const [start, end] of sorted) {
    const last = merged[merged.length - 1];
    if (last && start <= last[1]) {
      last[1] = Math.max(last[1], end);
    } else {
      merged.push([start, end]);
    }
  }
  return merged;
}

/**
 * Returns incomplete tasks already due on `day`. Completed tasks are excluded, since they no longer represent
 * outstanding load on that day.
 */
function tasksDueOn(day: Date, tasks: Task[]): Task[] {
  return tasks.filter((t) => !t.completed && t.due !== undefined && isSameLocalDay(t.due, day));
}

/**
 * Returns local midnight of `date`'s day.
 */
function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

/**
 * Returns local midnight of the day `days` days after `date`'s day.
 */
function addDays(date: Date, days: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

/**
 * Returns `day` (a local-midnight date) at the given number of minutes past local midnight.
 * Built from calendar fields rather than adding milliseconds, so DST transition days still land on the
 * intended wall-clock time.
 */
function atMinutes(day: Date, minutes: number): Date {
  return new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, minutes);
}

/**
 * True when `date` falls on the same local calendar day as `day` (a local-midnight date).
 */
function isSameLocalDay(date: Date, day: Date): boolean {
  return (
    date.getFullYear() === day.getFullYear() && date.getMonth() === day.getMonth() && date.getDate() === day.getDate()
  );
}
