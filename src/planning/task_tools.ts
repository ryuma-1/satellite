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
  if (task.taskListId !== undefined) view.taskListId = task.taskListId;
  return view;
}

/**
 * De-duplicated list of the default task list and every configured extra task list id.
 * Mirrors resolveCalendarIds's role for calendarId: the single source of truth for which task lists a
 * GoogleTasksAdapter (or its callers) query.
 * @param taskListIds Extra task list ids beyond the default (mcp_config.json's tasks.taskListIds).
 * @param defaultTaskListId Google Tasks' identifier for a user's default task list (DEFAULT_TASK_LIST_ID).
 */
export function resolveTaskListIds(taskListIds: string[], defaultTaskListId: string): string[] {
  return [...new Set([defaultTaskListId, ...taskListIds])];
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
 * Wraps TaskService as an AI SDK tool (design_doc §5.3 pattern, extended for issue #3), instead of exposing
 * the MCP server's tools directly. Only list_tasks is exposed; creation/update/deletion are out of scope.
 * @param taskListIds De-duplicated task lists queried by `service` (default plus any configured extras),
 * mentioned in the tool description only when there is more than the default list.
 */
export function createTaskTools(service: TaskService, taskListIds: string[]): ToolSet {
  const scopeHint =
    taskListIds.length > 1
      ? ` Merges tasks across every configured task list: ${taskListIds.join(", ")}.`
      : "";

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
