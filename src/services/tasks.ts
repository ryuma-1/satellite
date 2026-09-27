/**
 * A task in the service-independent model shared by all task adapters.
 */
export interface Task {
  /** Identifier assigned by the backing task service. */
  id: string;
  /** Human-readable title of the task. */
  title: string;
  /**
   * Due date, when set. Google Tasks only carries a date (no time-of-day), so this is local midnight of
   * that day, mirroring how CalendarEvent treats all-day events.
   */
  due?: Date;
  /** True when the task has been marked done. */
  completed: boolean;
  /** Free-form notes attached to the task. */
  notes?: string;
  /**
   * Nickname of the account the task belongs to (e.g. "personal", "school").
   * Always set once the service is configured with named accounts (design decision, issue #5).
   */
  account?: string;
  /**
   * Id of the task list the task belongs to (e.g. a non-default list).
   * Undefined when the service is only configured with its default task list.
   */
  taskListId?: string;
}

/**
 * Filter for listing tasks. All fields are optional so callers can query an unfiltered list.
 */
export interface ListTasksParams {
  /**
   * Only tasks due on or before `dueBefore`'s day are returned. Because Task.due only carries a day (no
   * time-of-day), the entire day `dueBefore` falls in is included regardless of its time-of-day, unless
   * `dueBefore` is exactly local midnight, in which case that day itself is excluded (a literal "before
   * this day starts" cutoff), matching the underlying Google Tasks due_max's exclusive semantics.
   * Callers translating a user-facing "on or before this day" input (e.g. createTaskTools, given a
   * date-only string) must pass local midnight of the *following* day to include that day, since this
   * field itself treats exact local midnight as excluding, not including, its own day.
   */
  dueBefore?: Date;
  /**
   * Only tasks due on or after `dueAfter`'s day are returned; the entire day `dueAfter` falls in is
   * included regardless of its time-of-day, matching the underlying Google Tasks due_min's inclusive
   * semantics.
   */
  dueAfter?: Date;
  /** When set, only tasks whose completion state matches this value are returned. */
  completed?: boolean;
}

/**
 * Read-only access to a user's tasks, exposed to the LLM as a tool (see design_doc, extended for issue #3).
 * Creation, update and deletion are out of scope for this iteration.
 */
export interface TaskService {
  /** Lists tasks matching the given filter, merged across all configured task lists. */
  listTasks(params?: ListTasksParams): Promise<Task[]>;
}
