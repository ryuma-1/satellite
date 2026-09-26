import type { McpToolCaller } from "../../mcp/client";
import type { ListTasksParams, Task, TaskService } from "../../services/tasks";
import { toDueMaxTimestamp, toDueTimestamp, toTask } from "./mapper";

/**
 * Google Tasks' identifier for a user's default task list, always queried in addition to any configured
 * extra lists.
 */
export const DEFAULT_TASK_LIST_ID = "@default";

/**
 * Tasks requested per page; the server caps google_tasks_list_tasks's `limit` at 100.
 */
const PAGE_LIMIT = 100;

/**
 * Smallest `limit` retried down to when the server truncates a page's rendering (see listTasksPage);
 * the server itself requires at least 1.
 */
const MIN_PAGE_LIMIT = 1;

/**
 * Options for GoogleTasksAdapter.
 */
export interface GoogleTasksAdapterOptions {
  /**
   * Additional task list ids read alongside the default list ("@default"). Empty when only the default
   * list is used. Unlike GoogleCalendarAdapter, there is no accounts concept here: every configured task
   * list belongs to the single account this MCP server is authenticated as (design decision, issue #3).
   */
  taskListIds?: string[];
}

/**
 * TaskService backed by @girmmy/google-tasks-mcp-server. Read-only (list only); creation, update and
 * deletion are out of scope for this iteration.
 */
export class GoogleTasksAdapter implements TaskService {
  /** Additional task list ids queried alongside DEFAULT_TASK_LIST_ID (see GoogleTasksAdapterOptions). */
  private readonly taskListIds: string[];

  /**
   * @param caller Connection used to invoke the server's tools.
   */
  constructor(
    private readonly caller: McpToolCaller,
    options: GoogleTasksAdapterOptions = {},
  ) {
    this.taskListIds = options.taskListIds ?? [];
  }

  /**
   * Lists tasks via "google_tasks_list_tasks", once per configured task list ("@default" plus any extras),
   * and merges the results (calendar's Promise.allSettled + failure-aggregation pattern).
   * The server's show_completed flag can only include or exclude completed tasks, not select only them,
   * so every call always requests everything (show_completed: true, show_deleted/show_hidden: false) and
   * `params.completed` is applied here afterward instead.
   */
  async listTasks(params: ListTasksParams = {}): Promise<Task[]> {
    const targets = [DEFAULT_TASK_LIST_ID, ...this.taskListIds];
    const results = await Promise.allSettled(targets.map((taskListId) => this.listTasksFor(taskListId, params)));

    const failures = results.flatMap((r, i) => {
      if (r.status !== "rejected") return [];
      return [`${targets[i]}: ${(r.reason as Error).message}`];
    });
    // Returning only the successful task lists would silently hide tasks, so any failure fails the call.
    if (failures.length > 0) {
      throw new Error(`google_tasks_list_tasks failed for ${failures.length} task list(s):\n${failures.join("\n")}`);
    }

    const tasks = results.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
    return params.completed === undefined ? tasks : tasks.filter((t) => t.completed === params.completed);
  }

  /**
   * Fetches and converts every page of tasks for a single task list, following `next_page_token` until
   * `has_more` reports none left.
   */
  private async listTasksFor(taskListId: string, params: ListTasksParams): Promise<Task[]> {
    const taggedTaskListId = this.taggedTaskListId(taskListId);
    const tasks: Task[] = [];
    let pageToken: string | undefined;
    do {
      const page = await this.listTasksPage(taskListId, params, pageToken);
      for (const raw of page.tasks) tasks.push(toTask(raw, taggedTaskListId));
      pageToken = page.has_more ? page.next_page_token : undefined;
    } while (pageToken !== undefined);
    return tasks;
  }

  /**
   * Calls "google_tasks_list_tasks" for one page and validates the response shape.
   * The server can locally truncate a page (halving its `tasks` array, independently of Google's own
   * `next_page_token` pagination) whenever the rendered markdown for the full page would exceed its
   * character limit, without ever indicating *which* items it dropped. Silently accepting a truncated
   * page would lose those tasks for good (no cursor exists to resume mid-page), so on truncation this
   * retries the same page with a smaller `limit` until the whole page's rendering fits, or fails loudly
   * once `limit` can no longer be lowered.
   */
  private async listTasksPage(
    taskListId: string,
    params: ListTasksParams,
    pageToken: string | undefined,
  ): Promise<TasksPage> {
    let limit = PAGE_LIMIT;
    for (;;) {
      const result = await this.caller.callTool("google_tasks_list_tasks", {
        tasklist_id: taskListId,
        limit,
        show_completed: true,
        show_deleted: false,
        show_hidden: false,
        ...(pageToken !== undefined && { page_token: pageToken }),
        ...(params.dueAfter && { due_min: toDueTimestamp(params.dueAfter) }),
        ...(params.dueBefore && { due_max: toDueMaxTimestamp(params.dueBefore) }),
      });
      const page = expectTasksPage(result, taskListId);
      if (!page.truncated) return page;
      if (limit <= MIN_PAGE_LIMIT) {
        throw new Error(
          `google_tasks_list_tasks: task list "${taskListId}" kept truncating its response even at ` +
            `limit=${MIN_PAGE_LIMIT}; a single task's rendered content is too large to fetch safely`,
        );
      }
      limit = Math.max(MIN_PAGE_LIMIT, Math.floor(limit / 2));
    }
  }

  /**
   * Returns taskListId only when extra task lists are configured, keeping TaskView minimal for the common
   * single-list setup, mirroring how GoogleCalendarAdapter only tags calendarId when extra calendars exist.
   */
  private taggedTaskListId(taskListId: string): string | undefined {
    return this.taskListIds.length > 0 ? taskListId : undefined;
  }
}

/**
 * Shape of google_tasks_list_tasks's structuredContent that the adapter consumes.
 */
interface TasksPage {
  /** Raw task resources for this page (only the ones the server kept, when `truncated` is true). */
  tasks: unknown[];
  /** True when there is a further page to fetch, from either Google's own pagination or local truncation. */
  has_more: boolean;
  /** Opaque cursor for Google's own next page; present only when Google itself has more results. */
  next_page_token?: string;
  /**
   * True when the server dropped some of this page's tasks to keep its rendered markdown under its
   * character limit (surfaced as a `truncation_message` in the raw response). listTasksPage retries
   * with a smaller `limit` whenever this is set, so callers of listTasksPage should never see it set.
   */
  truncated: boolean;
}

/**
 * Extracts and validates a list-tasks page from a tool result, failing loudly if the response shape changed.
 */
function expectTasksPage(result: unknown, taskListId: string): TasksPage {
  if (typeof result !== "object" || result === null || !("tasks" in result) || !("has_more" in result)) {
    throw new Error(
      `google_tasks_list_tasks: unexpected response for task list "${taskListId}": ${JSON.stringify(result)}`,
    );
  }
  const r = result as Record<string, unknown>;
  if (!Array.isArray(r.tasks)) {
    throw new Error(`google_tasks_list_tasks: "tasks" is not an array for task list "${taskListId}"`);
  }
  return {
    tasks: r.tasks,
    has_more: r.has_more === true,
    next_page_token: typeof r.next_page_token === "string" ? r.next_page_token : undefined,
    truncated: typeof r.truncation_message === "string",
  };
}
