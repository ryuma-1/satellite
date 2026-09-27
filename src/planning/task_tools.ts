import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { DEFAULT_WORKING_HOURS, type WorkingHours } from "../config/schedule_config";
import type { CalendarService } from "../services/calendar";
import type { NewTask, Task, TaskService } from "../services/tasks";
import { DATE_ONLY, formatLocalDate, formatLocalDateTime, parseDateInput } from "./datetime";
import { computeFreeSlotRange, DEFAULT_ESTIMATED_HOURS, findFreeSlot, hasCandidateWorkingDay } from "./due_date_suggestion";
import { checkTaskDraft, type TaskDraftInput } from "./task_draft";
import { withEstimateMarker } from "./task_estimate";

/**
 * Task as returned to the LLM: the due date becomes a plain YYYY-MM-DD string so the tool result is
 * plain JSON, mirroring how CalendarEventView formats all-day event dates.
 */
export interface TaskView {
  /** Task id. */
  id: string;
  /** Task title. */
  title: string;
  /** Due date as YYYY-MM-DD, when set. */
  due?: string;
  /** True when the task has been marked done. */
  completed: boolean;
  /** Free-form notes. */
  notes?: string;
  /** Owning account nickname, always set once accounts are configured (mirrors CalendarEventView.account). */
  account?: string;
  /** Id of the task list the task belongs to, when multiple task lists are configured. */
  taskListId?: string;
  /** Id of the parent task, when this task is a subtask. */
  parent?: string;
}

/**
 * Converts a task into the JSON shape exposed to the LLM.
 */
export function toTaskView(task: Task): TaskView {
  const view: TaskView = {
    id: task.id,
    title: task.title,
    completed: task.completed,
  };
  if (task.due !== undefined) view.due = formatLocalDate(task.due);
  if (task.notes !== undefined) view.notes = task.notes;
  if (task.account !== undefined) view.account = task.account;
  if (task.taskListId !== undefined) view.taskListId = task.taskListId;
  if (task.parent !== undefined) view.parent = task.parent;
  return view;
}

/**
 * An account's full task list set (its default list plus its own extras), used to describe multi-list
 * accounts to the LLM. Defined locally, mirroring GoogleTasksAccount, so this module does not depend on
 * adapter or config types (same rationale as calendar_tools.ts's AccountCalendarIds).
 */
export interface AccountTaskLists {
  /** Account nickname. */
  name: string;
  /** All task list ids configured for this account, default first. */
  taskListIds: string[];
}

/**
 * Builds the per-account task list sets consumed by createTaskTools and buildSystemPrompt: each account's
 * default task list plus its own extras. Mirrors resolveCalendarIds/resolveAccountCalendars's role for
 * calendars: the single source of truth for which task lists a GoogleTasksAdapter (or its callers) query.
 * @param accounts Configured accounts, each with its own extra task list ids beyond the default.
 * @param defaultTaskListId Google Tasks' identifier for a user's default task list (DEFAULT_TASK_LIST_ID).
 */
export function resolveAccountTaskLists(
  accounts: { name: string; taskListIds: string[] }[],
  defaultTaskListId: string,
): AccountTaskLists[] {
  return accounts.map((a) => ({ name: a.name, taskListIds: [defaultTaskListId, ...a.taskListIds] }));
}

/**
 * Description shared by dueBefore/dueAfter, so the LLM formats them consistently with list_events.
 */
const DATE_HINT = "ISO 8601 date or date-time (e.g. 2026-09-25 or 2026-09-25T15:00:00+09:00)";

/**
 * Parses a dueBefore input so a date-only value reads as "on or before this day, inclusive" (the natural
 * reading of a task due date, which carries no time-of-day), while a timed value keeps the literal
 * instant-cutoff semantics ListTasksParams.dueBefore documents (handled downstream by the adapter's
 * toDueMaxTimestamp).
 * parseDateInput alone cannot make this distinction: a date-only string and an exact-local-midnight timed
 * string both parse to the identical Date, so the raw string must be inspected here, before that
 * information is lost.
 */
function parseDueBefore(value: string): Date {
  const dateOnly = DATE_ONLY.exec(value);
  if (!dateOnly) return parseDateInput(value, "dueBefore");

  // Advance to local midnight of the following day: toDueMaxTimestamp keeps an exact-local-midnight Date
  // as-is, so this reads as "before the following day", i.e. the whole of `value`'s day is included.
  const [, year, month, day] = dateOnly;
  return new Date(Number(year), Number(month) - 1, Number(day) + 1);
}

/**
 * Builds the tool description's scope hint, mentioning every account/task-list combination only when there
 * is more than the single default list of a single account to disambiguate.
 */
function describeScope(accountTaskLists: AccountTaskLists[]): string {
  const hasExtras = accountTaskLists.length > 1 || accountTaskLists.some((a) => a.taskListIds.length > 1);
  if (!hasExtras) return "";
  const perAccount = accountTaskLists.map((a) => `${a.name}: ${a.taskListIds.join(", ")}`);
  return ` Merges tasks across every account and task list: ${perAccount.join("; ")}.`;
}

/**
 * Schema shape for the optional `account` argument, mirroring calendar_tools.ts's accountShape.
 */
type AccountShape = { account: z.ZodOptional<z.ZodEnum<Record<string, string>>> };

/**
 * Builds the optional `account` argument. Omitted only when there are no accounts at all (mirrors
 * calendar_tools.ts's accountShape; see its doc comment for why zero, not one, is the cutoff).
 */
function accountShape(accounts: string[], purpose: string): AccountShape {
  if (accounts.length === 0) {
    // Typed as present so tool inputs infer `account: string | undefined`; an absent key reads as undefined.
    return {} as AccountShape;
  }
  return {
    account: z
      .enum(accounts as [string, ...string[]])
      .optional()
      .describe(purpose),
  };
}

/**
 * Schema shape for the optional `taskListId` argument, mirroring calendar_tools.ts's calendarIdShape.
 */
type TaskListIdShape = { taskListId: z.ZodOptional<z.ZodEnum<Record<string, string>>> };

/**
 * Builds the optional `taskListId` argument. Omitted when at most the default task list is configured, since
 * there is then nothing to disambiguate (mirrors calendar_tools.ts's calendarIdShape).
 */
function taskListIdShape(taskListIds: string[], purpose: string): TaskListIdShape {
  if (taskListIds.length <= 1) {
    // Typed as present so tool inputs infer `taskListId: string | undefined`; an absent key reads as undefined.
    return {} as TaskListIdShape;
  }
  return {
    taskListId: z
      .enum(taskListIds as [string, ...string[]])
      .optional()
      .describe(purpose),
  };
}

/**
 * Optional settings for createTaskTools.
 */
export interface TaskToolsOptions {
  /**
   * Returns the current time; injectable so find_free_slot is deterministic in tests. Defaults to the real
   * current time.
   */
  now?: () => Date;
  /** The user's working time (schedule_config.json) find_free_slot schedules into; defaults to Mon-Fri 9-18. */
  workingHours?: WorkingHours;
}

/**
 * Wraps TaskService as AI SDK tools (design_doc §5.3 pattern, extended for issue #3/#5, then #7/#9 for
 * create_task/check_task_draft/find_free_slot), instead of exposing gws directly. update_task/delete_task
 * remain out of scope.
 * @param accountTaskLists Every account's task lists (default plus configured extras), from
 * resolveAccountTaskLists; mentioned in tool descriptions/schemas only when there is more than one to disambiguate.
 * @param calendarService Used by find_free_slot to read calendar availability; not otherwise exposed here
 * (list_events/create_event etc. are createCalendarTools' responsibility).
 * @param options See TaskToolsOptions.
 */
export function createTaskTools(
  service: TaskService,
  accountTaskLists: AccountTaskLists[],
  calendarService: CalendarService,
  options: TaskToolsOptions = {},
): ToolSet {
  const now = options.now ?? (() => new Date());
  const workingHours = options.workingHours ?? DEFAULT_WORKING_HOURS;
  const scopeHint = describeScope(accountTaskLists);
  const accounts = accountTaskLists.map((a) => a.name);
  const taskListIds = [...new Set(accountTaskLists.flatMap((a) => a.taskListIds))];
  const targetAccount = accountShape(accounts, `Account to create the task in. Defaults to "${accounts[0]}".`);
  const targetTaskListId = taskListIdShape(
    taskListIds,
    `Task list to create the task in; must belong to the chosen \`account\`. Defaults to "${taskListIds[0]}".`,
  );

  return {
    list_tasks: tool({
      description: `List tasks, optionally filtered by due date range and completion state.${scopeHint}`,
      inputSchema: z.object({
        dueBefore: z
          .string()
          .optional()
          .describe(
            `Only tasks due on or before this day are returned, inclusive (task due dates carry no ` +
              `time-of-day). A date-only value includes that day entirely; a timed value also includes the ` +
              `day it falls on, unless it is exactly local midnight, which excludes that day (a literal ` +
              `"before this instant" cutoff). ${DATE_HINT}`,
          ),
        dueAfter: z
          .string()
          .optional()
          .describe(
            `Only tasks due on or after this day are returned (task due dates carry no time-of-day). ${DATE_HINT}`,
          ),
        completed: z.boolean().optional().describe("When set, only returns tasks matching this completion state."),
      }),
      execute: async ({ dueBefore, dueAfter, completed }) => {
        const tasks = await service.listTasks({
          dueBefore: dueBefore !== undefined ? parseDueBefore(dueBefore) : undefined,
          dueAfter: dueAfter !== undefined ? parseDateInput(dueAfter, "dueAfter") : undefined,
          completed,
        });
        return tasks.map(toTaskView);
      },
    }),

    create_task: tool({
      description:
        "Create a task and return it as stored. To create a subtask, pass `parent` with an existing task's " +
        "id (e.g. from list_tasks or a prior create_task result).",
      inputSchema: z.object({
        title: z.string().describe("Task title"),
        due: z
          .string()
          .optional()
          .describe(
            `Due date; should be a plain date (YYYY-MM-DD). Google Tasks stores only the date part, so a ` +
              `time-of-day, if given, is converted to local time and then discarded. ${DATE_HINT}`,
          ),
        notes: z.string().optional().describe("Notes"),
        estimatedHours: z
          .number()
          .positive()
          .optional()
          .describe(
            "Estimated hours the task will take (the same value passed to find_free_slot). Recorded in the " +
              "task's notes so later due-date suggestions count it against that day's working time. When " +
              "splitting into subtasks, set it on each subtask rather than on the parent.",
          ),
        parent: z.string().optional().describe("Id of an existing task to create this task as a subtask of"),
        ...targetAccount,
        ...targetTaskListId,
      }),
      execute: async (input) => {
        const task: NewTask = {
          title: input.title,
          due: input.due !== undefined ? parseDateInput(input.due, "due") : undefined,
          notes: input.estimatedHours !== undefined ? withEstimateMarker(input.notes, input.estimatedHours) : input.notes,
          parent: input.parent,
          account: input.account,
          taskListId: input.taskListId,
        };
        return toTaskView(await service.createTask(task));
      },
    }),

    check_task_draft: tool({
      description:
        "Check whether a task draft has every field required before calling create_task (title, " +
        "estimatedHours, deadline). Call this before create_task, and after every ask_user answer, until " +
        "`complete: true`; `missing` lists which fields still need an ask_user question.",
      inputSchema: z.object({
        title: z.string().optional().describe("Task title, if known"),
        estimatedHours: z.number().optional().describe("Estimated hours the task will take, if known"),
        deadline: z.string().optional().describe(`Deadline, if known. ${DATE_HINT}`),
      }),
      execute: async (input: TaskDraftInput) => checkTaskDraft(input),
    }),

    find_free_slot: tool({
      description:
        "Find the earliest working day, up to a deadline, whose working time, minus calendar events and the " +
        "estimated hours of tasks already due that day, still has a free interval long enough for a new task " +
        "(never guess a due date yourself; call this once the task's deadline and estimatedHours are known). " +
        "Save `date` as the task's due date; `slotStart` is a reference start time for display only and " +
        "should not be saved. `fits: false` means no day up to the deadline has room; tell the user so when " +
        "presenting the date.",
      inputSchema: z.object({
        deadline: z.string().describe(`Deadline the task must be done by. ${DATE_HINT}`),
        estimatedHours: z
          .number()
          .positive()
          .optional()
          .describe(`Estimated hours the task will take; defaults to ${DEFAULT_ESTIMATED_HOURS}.`),
      }),
      execute: async ({ deadline, estimatedHours }) => {
        const parsedDeadline = parseDateInput(deadline, "deadline");
        // Read the clock once so the fetch window and the candidate walk cannot disagree across midnight.
        const current = now();
        // A deadline of today (or the past) leaves no candidate day at all; fail with the friendly message
        // before fetching, instead of computeFreeSlotRange producing timeMin >= timeMax for the Calendar API.
        if (!hasCandidateWorkingDay(current, parsedDeadline, workingHours)) {
          throw new Error("no working day between tomorrow and the deadline");
        }
        // Bounds the calendar/task fetch to exactly the window findFreeSlot can draw a candidate from,
        // instead of an unfiltered fetch that would page through a user's entire event/task history.
        const range = computeFreeSlotRange(current, parsedDeadline);
        const [tasks, events] = await Promise.all([
          service.listTasks({ dueAfter: range.start, dueBefore: range.end, completed: false }),
          calendarService.listEvents({ from: range.start, to: range.end }),
        ]);
        const suggestion = findFreeSlot({
          now: current,
          deadline: parsedDeadline,
          events,
          tasks,
          estimatedHours,
          workingHours,
        });
        return {
          date: formatLocalDate(suggestion.date),
          slotStart: formatLocalDateTime(suggestion.slotStart),
          freeHours: suggestion.freeHours,
          tasksDueThatDay: suggestion.tasksDueThatDay,
          taskHours: suggestion.taskHours,
          remainingHours: suggestion.remainingHours,
          fits: suggestion.fits,
        };
      },
    }),
  };
}
