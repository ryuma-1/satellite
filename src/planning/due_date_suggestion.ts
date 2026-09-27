import type { CalendarEvent } from "../services/calendar";
import type { Task } from "../services/tasks";

/**
 * Number of candidate weekdays (Mon-Fri) searched for a due-date candidate when the caller does not
 * override it. Weekends are skipped entirely (see isWeekend), so this counts working days, not calendar days.
 */
export const DEFAULT_SEARCH_DAYS = 14;

/**
 * Estimated hours a new task takes when the caller does not provide its own estimate.
 */
export const DEFAULT_ESTIMATED_HOURS = 1;

/**
 * Local hour a working day starts, used to compute a candidate day's free time.
 */
export const WORKING_HOURS_START = 9;

/**
 * Local hour a working day ends (exclusive), used to compute a candidate day's free time.
 */
export const WORKING_HOURS_END = 18;

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
  /** Number of candidate weekdays to search; defaults to DEFAULT_SEARCH_DAYS. */
  searchDays?: number;
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
 * Walks forward weekday by weekday, starting tomorrow (skipping Saturday/Sunday: see isWeekend), and returns
 * the first day with both enough free time (>= estimatedHours within working hours, after subtracting
 * overlapping events) and a manageable existing task load (< MAX_TASKS_PER_DAY tasks already due that day).
 * If no day within the search window satisfies both, the last day searched is returned anyway (with its own,
 * less favorable numbers): suggesting nothing would be less useful than a tight but explainable candidate,
 * and the confirmation flow (request_confirmation) still lets the user reject it.
 */
export function suggestDueDate(input: SuggestDueDateInput): DueDateSuggestion {
  const dailyCapacity = WORKING_HOURS_END - WORKING_HOURS_START;
  // An estimate larger than a single day's working hours can never be satisfied by any one day in this
  // model (it only ever schedules onto a single candidate day), so it would otherwise always fall through to
  // the last searched day regardless of how free that day actually is. Clamping to the daily capacity instead
  // picks the first day that is as free as a day can be, which is the closest useful approximation.
  const estimatedHours = Math.min(input.estimatedHours ?? DEFAULT_ESTIMATED_HOURS, dailyCapacity);
  const searchDays = input.searchDays ?? DEFAULT_SEARCH_DAYS;
  const today = startOfDay(input.now);

  let lastCandidate: DueDateSuggestion | undefined;
  for (const date of candidateWeekdays(today, searchDays)) {
    const candidate: DueDateSuggestion = {
      date,
      freeHours: freeHoursOn(date, input.events),
      tasksDueThatDay: tasksDueOn(date, input.tasks),
    };
    if (candidate.freeHours >= estimatedHours && candidate.tasksDueThatDay < MAX_TASKS_PER_DAY) {
      return candidate;
    }
    lastCandidate = candidate;
  }
  // lastCandidate is always set here, since callers always pass a positive searchDays (the tool layer
  // enforces this via zod) and candidateWeekdays always yields at least that many days, so the loop above
  // runs at least once.
  return lastCandidate!;
}

/**
 * Computes the calendar-day range suggestDueDate can possibly draw a candidate from, for `searchDays`
 * weekdays ahead of `now`, so callers that fetch calendar events/tasks to pass in (task_tools.ts's
 * suggest_due_date) can bound that fetch to exactly the days this module can use, instead of pulling a
 * user's entire event/task history.
 * @returns `start`: local midnight of tomorrow, the earliest day a candidate can fall on. `end`: local
 * midnight of the day after the last candidate weekday (exclusive), matching ListEventsParams.to /
 * ListTasksParams.dueBefore's exclusive-upper-bound semantics.
 */
export function computeSearchRange(now: Date, searchDays: number = DEFAULT_SEARCH_DAYS): { start: Date; end: Date } {
  const today = startOfDay(now);
  const weekdays = candidateWeekdays(today, searchDays);
  // weekdays always has at least one entry for a positive searchDays (the tool layer enforces this via
  // zod, mirroring suggestDueDate's own lastCandidate! below), so this is never empty in practice.
  const lastDay = weekdays[weekdays.length - 1]!;
  return { start: addDays(today, 1), end: addDays(lastDay, 1) };
}

/**
 * Returns the next `count` weekday (Mon-Fri) candidate days after `today`, in order, skipping weekends.
 * Shared by suggestDueDate (to evaluate each candidate) and computeSearchRange (to bound the calendar/task
 * fetch to precisely the days suggestDueDate can return), so the two stay in lockstep.
 */
function candidateWeekdays(today: Date, count: number): Date[] {
  const days: Date[] = [];
  for (let offset = 1; days.length < count; offset++) {
    const date = addDays(today, offset);
    if (!isWeekend(date)) days.push(date);
  }
  return days;
}

/**
 * True when `day` (a local-midnight date) falls on a Saturday or Sunday.
 * Weekend days are excluded from due-date candidates: this model only accounts for a Mon-Fri working week
 * (WORKING_HOURS_START/END), so suggesting a weekend date would imply working outside it.
 */
function isWeekend(day: Date): boolean {
  const weekday = day.getDay();
  return weekday === 0 || weekday === 6;
}

/**
 * Computes free hours within working hours on `day`, after subtracting time overlapping `events`.
 * An all-day event spanning `day` blocks the entire working day, on the assumption that a full-day
 * commitment (e.g. travel) leaves no realistic capacity for other work that day.
 */
function freeHoursOn(day: Date, events: CalendarEvent[]): number {
  const dayStart = atHour(day, WORKING_HOURS_START);
  const dayEnd = atHour(day, WORKING_HOURS_END);
  const totalMs = dayEnd.getTime() - dayStart.getTime();

  let busyMs = 0;
  for (const event of events) {
    if (event.allDay) {
      if (day.getTime() >= event.start.getTime() && day.getTime() < event.end.getTime()) {
        return 0;
      }
      continue;
    }
    const overlapStart = Math.max(event.start.getTime(), dayStart.getTime());
    const overlapEnd = Math.min(event.end.getTime(), dayEnd.getTime());
    if (overlapEnd > overlapStart) busyMs += overlapEnd - overlapStart;
  }
  return Math.max(totalMs - busyMs, 0) / (60 * 60 * 1000);
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
 * Returns `day` (a local-midnight date) at the given local hour.
 */
function atHour(day: Date, hour: number): Date {
  return new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour);
}

/**
 * True when `date` falls on the same local calendar day as `day` (a local-midnight date).
 */
function isSameLocalDay(date: Date, day: Date): boolean {
  return (
    date.getFullYear() === day.getFullYear() && date.getMonth() === day.getMonth() && date.getDate() === day.getDate()
  );
}
