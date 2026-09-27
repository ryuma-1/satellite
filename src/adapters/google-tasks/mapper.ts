import type { NewTask, Task } from "../../services/tasks";

/**
 * Raw task resource as returned in Google Tasks API's `items[]` (via `gws tasks tasks list`); identical shape
 * to the Tasks API's own Task resource (docs/spikes/gws-cli-0.22.5.md §6).
 */
export interface GoogleTask {
  /** Identifier assigned by Google Tasks. */
  id: string;
  /** Task title. */
  title: string;
  /** Completion state; "completed" is done, "needsAction" is not. */
  status: "needsAction" | "completed";
  /** Free-form notes attached to the task. */
  notes?: string;
  /** RFC 3339 timestamp, always UTC midnight (e.g. "2026-09-30T00:00:00.000Z"); date-only semantics. */
  due?: string;
  /** RFC 3339 timestamp the task was marked completed, when it has been. */
  completed?: string;
  /** Id of the parent task, when this task is a subtask. */
  parent?: string;
}

/**
 * Converts a raw task resource into the shared Task model.
 * @param account Nickname of the account the task was fetched from; always set once accounts are configured.
 * @param taskListId Id of the task list the task was fetched from, when multiple task lists are configured.
 */
export function toTask(raw: unknown, account?: string, taskListId?: string): Task {
  if (!isGoogleTask(raw)) {
    throw new Error(`Unexpected task shape from gws: ${JSON.stringify(raw)}`);
  }

  const task: Task = {
    id: raw.id,
    title: raw.title,
    completed: raw.status === "completed",
  };
  if (raw.due !== undefined) task.due = parseDueDate(raw.due);
  if (raw.notes !== undefined) task.notes = raw.notes;
  if (raw.parent !== undefined) task.parent = raw.parent;
  if (account !== undefined) task.account = account;
  if (taskListId !== undefined) task.taskListId = taskListId;
  return task;
}

/**
 * Converts a NewTask into the request body for `tasks.tasks.insert`.
 * `parent` is intentionally excluded: Google Tasks' `insert` takes the parent id as a query parameter of the
 * method itself, not a field of the Task resource body (docs/spikes/gws-cli-0.22.5.md §11, not yet verified
 * against a real account), so the adapter attaches it to the request's `params` instead of this body.
 */
export function toInsertBody(task: NewTask): Record<string, unknown> {
  const body: Record<string, unknown> = { title: task.title };
  if (task.notes !== undefined) body.notes = task.notes;
  if (task.due !== undefined) body.due = toDueTimestamp(task.due);
  return body;
}

/**
 * Converts a due-date filter bound into the RFC 3339 UTC timestamp gws's dueMin/dueMax expect.
 * Google Tasks' `due` only carries a date, always rendered at UTC midnight; building the timestamp from
 * `date`'s local Y/M/D components (rather than its UTC ones) keeps this the exact inverse of parseDueDate,
 * so a bound built from "today" always matches "today"'s tasks regardless of the host's UTC offset.
 * This is gws's dueMin ("on or after"), which is inclusive by construction: a task due on the same day as
 * `date` shares its exact UTC-midnight instant, so it is never excluded regardless of `date`'s time-of-day.
 */
export function toDueTimestamp(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}T00:00:00.000Z`;
}

/**
 * Converts a `dueBefore` filter bound into the RFC 3339 UTC timestamp gws's dueMax ("before", exclusive) expects.
 * Because `due` only carries a date, a task due the same day as `date` shares `date`'s truncated
 * UTC-midnight instant, so a plain toDueTimestamp(date) would exclude it as soon as `date` carries any
 * time-of-day at all (e.g. "2026-09-30T15:00" would wrongly drop tasks due on the 30th, since the
 * timestamp compared is equal to, not less than, that day's own UTC midnight). Rounding up to the next
 * day keeps that day's tasks included whenever `date` is not already exactly local midnight; an exact
 * midnight input is kept as-is, so "before 2026-09-30 00:00" still excludes the 30th entirely, matching
 * the literal meaning of a day-boundary cutoff.
 */
export function toDueMaxTimestamp(date: Date): string {
  const isLocalMidnight =
    date.getHours() === 0 && date.getMinutes() === 0 && date.getSeconds() === 0 && date.getMilliseconds() === 0;
  const bound = isLocalMidnight ? date : new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1);
  return toDueTimestamp(bound);
}

/**
 * Parses a `due` value as local midnight of its date part.
 * The value is always UTC midnight (date-only semantics); naively doing `new Date(due)` and later reading
 * local getters would shift the date back a day in timezones west of UTC. Taking only the YYYY-MM-DD part
 * and constructing local midnight from it mirrors how the calendar mapper treats all-day event dates.
 */
function parseDueDate(due: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(due);
  if (!match) throw new Error(`Invalid due date: ${due}`);
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

/**
 * Structural check for the fields toTask relies on.
 */
function isGoogleTask(value: unknown): value is GoogleTask {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.id === "string" && typeof v.title === "string" && typeof v.status === "string";
}
