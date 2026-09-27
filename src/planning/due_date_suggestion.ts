import { DEFAULT_WORKING_HOURS, type WorkingHours, type WorkingRange } from "../config/schedule_config";
import type { CalendarEvent } from "../services/calendar";
import type { Task } from "../services/tasks";

/**
 * Number of candidate working days searched for a due-date candidate when the caller does not override it.
 * Days with no working time (see WorkingHours) are skipped entirely, so this counts working days, not
 * calendar days.
 */
export const DEFAULT_SEARCH_DAYS = 14;

/**
 * Estimated hours a new task takes when the caller does not provide its own estimate.
 */
export const DEFAULT_ESTIMATED_HOURS = 1;

/**
 * Milliseconds per hour, for converting overlap durations into the hours reported to callers.
 */
const MS_PER_HOUR = 60 * 60 * 1000;

/**
 * Maximum number of existing, incomplete tasks already due on a candidate day before it is skipped as
 * overloaded, regardless of how much free calendar time remains that day.
 */
export const MAX_TASKS_PER_DAY = 3;

/**
 * Inputs for suggestDueDate.
 */
export interface SuggestDueDateInput {
  /** Current time; the search starts the day after this. */
  now: Date;
  /** Existing calendar events, used to compute each candidate day's free time. */
  events: CalendarEvent[];
  /** Existing tasks, used to compute each candidate day's task load. */
  tasks: Task[];
  /** Estimated hours the new task will take; defaults to DEFAULT_ESTIMATED_HOURS. */
  estimatedHours?: number;
  /** Number of candidate working days to search; defaults to DEFAULT_SEARCH_DAYS. */
  searchDays?: number;
  /** The user's working time per weekday (schedule_config.json); defaults to DEFAULT_WORKING_HOURS. */
  workingHours?: WorkingHours;
}

/**
 * A candidate due date and the numbers behind why it was chosen, so callers (and the LLM) can explain the
 * suggestion to the user instead of presenting a bare date.
 */
export interface DueDateSuggestion {
  /** Candidate date, as local midnight. */
  date: Date;
  /** Free hours within working hours on that day, after subtracting overlapping calendar events. */
  freeHours: number;
  /** Number of existing, incomplete tasks already due that day. */
  tasksDueThatDay: number;
}

/**
 * Suggests a due date for a new task from existing calendar/task load, instead of asking the LLM to do this
 * arithmetic itself (design_doc §3.2: calculations the code can guarantee should not be left to the LLM).
 * This is a lightweight, dependency-free stand-in for a real scheduling optimizer (Timefold Solver was
 * considered and rejected as overkill for suggesting a single task's due date; see the implementation plan's
 * risk notes).
 *
 * Only working time counts as capacity: free time and sleep outside the configured working hours are never
 * scheduled into. Walks forward working day by working day, starting tomorrow (skipping days with no working
 * time), and returns
 * the first day with both enough free time (>= estimatedHours within working hours, after subtracting
 * overlapping events) and a manageable existing task load (< MAX_TASKS_PER_DAY tasks already due that day).
 * If no day within the search window satisfies both, the last day searched is returned anyway (with its own,
 * less favorable numbers): suggesting nothing would be less useful than a tight but explainable candidate,
 * and the confirmation flow (request_confirmation) still lets the user reject it.
 */
export function suggestDueDate(input: SuggestDueDateInput): DueDateSuggestion {
  const workingHours = input.workingHours ?? DEFAULT_WORKING_HOURS;
  // An estimate larger than the longest working day can never be satisfied by any one day in this model (it
  // only ever schedules onto a single candidate day), so it would otherwise always fall through to the last
  // searched day regardless of how free that day actually is. Clamping to the longest day's capacity instead
  // picks the first day that is as free as a day can be, which is the closest useful approximation.
  const maxDailyCapacity = Math.max(...workingHours.map(capacityHours));
  const estimatedHours = Math.min(input.estimatedHours ?? DEFAULT_ESTIMATED_HOURS, maxDailyCapacity);
  const searchDays = input.searchDays ?? DEFAULT_SEARCH_DAYS;
  const today = startOfDay(input.now);

  let lastCandidate: DueDateSuggestion | undefined;
  for (const date of candidateDays(today, searchDays, workingHours)) {
    const candidate: DueDateSuggestion = {
      date,
      freeHours: freeHoursOn(date, workingHours[date.getDay()]!, input.events),
      tasksDueThatDay: tasksDueOn(date, input.tasks),
    };
    if (candidate.freeHours >= estimatedHours && candidate.tasksDueThatDay < MAX_TASKS_PER_DAY) {
      return candidate;
    }
    lastCandidate = candidate;
  }
  // lastCandidate is always set here, since callers always pass a positive searchDays (the tool layer
  // enforces this via zod) and candidateDays always yields at least that many days, so the loop above
  // runs at least once.
  return lastCandidate!;
}

/**
 * Computes the calendar-day range suggestDueDate can possibly draw a candidate from, for `searchDays`
 * working days ahead of `now`, so callers that fetch calendar events/tasks to pass in (task_tools.ts's
 * suggest_due_date) can bound that fetch to exactly the days this module can use, instead of pulling a
 * user's entire event/task history.
 * @returns `start`: local midnight of tomorrow, the earliest day a candidate can fall on. `end`: local
 * midnight of the day after the last candidate working day (exclusive), matching ListEventsParams.to /
 * ListTasksParams.dueBefore's exclusive-upper-bound semantics.
 */
export function computeSearchRange(
  now: Date,
  searchDays: number = DEFAULT_SEARCH_DAYS,
  workingHours: WorkingHours = DEFAULT_WORKING_HOURS,
): { start: Date; end: Date } {
  const today = startOfDay(now);
  const days = candidateDays(today, searchDays, workingHours);
  // days always has at least one entry for a positive searchDays (the tool layer enforces this via zod,
  // mirroring suggestDueDate's own lastCandidate! above), so this is never empty in practice.
  const lastDay = days[days.length - 1]!;
  return { start: addDays(today, 1), end: addDays(lastDay, 1) };
}

/**
 * Returns the next `count` days after `today` that have working time, in order, skipping days off.
 * Shared by suggestDueDate (to evaluate each candidate) and computeSearchRange (to bound the calendar/task
 * fetch to precisely the days suggestDueDate can return), so the two stay in lockstep.
 * Days off are excluded outright: suggesting one would imply working outside the configured working hours.
 */
function candidateDays(today: Date, count: number, workingHours: WorkingHours): Date[] {
  if (workingHours.every((ranges) => ranges.length === 0)) {
    // parseScheduleConfig already rejects this; guarded here too because the loop below would never end.
    throw new Error("workingHours has no working time on any weekday");
  }
  const days: Date[] = [];
  for (let offset = 1; days.length < count; offset++) {
    const date = addDays(today, offset);
    if (workingHours[date.getDay()]!.length > 0) days.push(date);
  }
  return days;
}

/**
 * Total working hours in one weekday's ranges, ignoring calendar events.
 */
function capacityHours(ranges: readonly WorkingRange[]): number {
  return ranges.reduce((sum, r) => sum + (r.endMinutes - r.startMinutes), 0) / 60;
}

/**
 * Computes free hours within `ranges` (the day's working time) on `day`, after subtracting time covered by
 * `events`. Events are merged into disjoint busy intervals first, so overlapping events (e.g. the same meeting
 * on two calendars) are not subtracted twice.
 * An all-day event spanning `day` blocks the entire working day, on the assumption that a full-day
 * commitment (e.g. travel) leaves no realistic capacity for other work that day.
 */
function freeHoursOn(day: Date, ranges: readonly WorkingRange[], events: CalendarEvent[]): number {
  const timed: Array<[number, number]> = [];
  for (const event of events) {
    if (event.allDay) {
      if (day.getTime() >= event.start.getTime() && day.getTime() < event.end.getTime()) {
        return 0;
      }
      continue;
    }
    timed.push([event.start.getTime(), event.end.getTime()]);
  }
  const busy = mergeIntervals(timed);

  let freeMs = 0;
  for (const range of ranges) {
    const rangeStart = atMinutes(day, range.startMinutes).getTime();
    const rangeEnd = atMinutes(day, range.endMinutes).getTime();
    let busyMs = 0;
    for (const [busyStart, busyEnd] of busy) {
      const overlapStart = Math.max(busyStart, rangeStart);
      const overlapEnd = Math.min(busyEnd, rangeEnd);
      if (overlapEnd > overlapStart) busyMs += overlapEnd - overlapStart;
    }
    freeMs += rangeEnd - rangeStart - busyMs;
  }
  return freeMs / MS_PER_HOUR;
}

/**
 * Merges [start, end) millisecond intervals into sorted, disjoint intervals.
 */
function mergeIntervals(intervals: Array<[number, number]>): Array<[number, number]> {
  const sorted = intervals.filter(([s, e]) => e > s).sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
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
 * Counts incomplete tasks already due on `day`. Completed tasks are excluded, since they no longer represent
 * outstanding load on that day.
 */
function tasksDueOn(day: Date, tasks: Task[]): number {
  return tasks.filter((t) => !t.completed && t.due !== undefined && isSameLocalDay(t.due, day)).length;
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
