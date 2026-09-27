import { tool, type ToolSet } from "ai";
import { z } from "zod";
import type { Task, TaskService } from "../services/tasks";
import { DATE_ONLY, formatLocalDate, parseDateInput } from "./datetime";

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
 * Wraps TaskService as an AI SDK tool (design_doc §5.3 pattern, extended for issue #3/#5), instead of exposing
 * gws directly. Only list_tasks is exposed; creation/update/deletion are out of scope.
 * @param accountTaskLists Every account's task lists (default plus configured extras), from
 * resolveAccountTaskLists; mentioned in the tool description only when there is more than one to disambiguate.
 */
export function createTaskTools(service: TaskService, accountTaskLists: AccountTaskLists[]): ToolSet {
  const scopeHint = describeScope(accountTaskLists);

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
  };
}
