import { fanOut } from "../../gws/fan_out";
import type { GwsCaller } from "../../gws/runner";
import type { ListTasksParams, Task, TaskService } from "../../services/tasks";
import { toDueMaxTimestamp, toDueTimestamp, toTask } from "./mapper";

/**
 * Google Tasks' identifier for a user's default task list, always queried in addition to any configured
 * extra lists.
 */
export const DEFAULT_TASK_LIST_ID = "@default";

/**
 * An account and the extra task lists it owns, as configured for GoogleTasksAdapter. Mirrors
 * GoogleCalendarAccount's role for GoogleCalendarAdapter (design decision, issue #5).
 */
export interface GoogleTasksAccount {
  /** Account nickname; must match a gws config directory set up via `bun run src/cli/auth.ts <name>`. */
  name: string;
  /** Additional task list ids read alongside this account's default list ("@default"). */
  taskListIds?: string[];
}

/**
 * Options for GoogleTasksAdapter.
 */
export interface GoogleTasksAdapterOptions {
  /**
   * Accounts to query, each with its own extra task lists. At least one is required (named-account mode is
   * mandatory, mirroring GoogleCalendarAdapter). A plain string is shorthand for an account with no extras.
   */
  accounts: (string | GoogleTasksAccount)[];
}

/**
 * TaskService backed by the gws CLI (docs/spikes/gws-cli-0.22.5.md), spanning one or more Google accounts and
 * task lists via GwsCaller. Read-only (list only); creation, update and deletion are out of scope for this
 * iteration.
 */
export class GoogleTasksAdapter implements TaskService {
  private readonly accounts: Required<GoogleTasksAccount>[];

  /**
   * @param caller Runs gws calls for a given account.
   */
  constructor(
    private readonly caller: GwsCaller,
    options: GoogleTasksAdapterOptions,
  ) {
    this.accounts = options.accounts.map((a) =>
      typeof a === "string" ? { name: a, taskListIds: [] } : { name: a.name, taskListIds: a.taskListIds ?? [] },
    );
    if (this.accounts.length === 0) {
      throw new Error("GoogleTasksAdapter requires at least one account");
    }
  }

  /**
   * Lists tasks via `tasks tasks list`, once per account/task-list pair ("@default" plus any extras), and
   * merges the results (mirrors GoogleCalendarAdapter.listEvents's fan-out pattern).
   * gws has no "completed only" mode, so every call always requests everything
   * (showCompleted: true, showDeleted/showHidden: false) and `params.completed` is applied here afterward.
   */
  async listTasks(params: ListTasksParams = {}): Promise<Task[]> {
    const targets = this.accounts.flatMap((account) =>
      [DEFAULT_TASK_LIST_ID, ...account.taskListIds].map((taskListId) => ({ account: account.name, taskListId })),
    );
    const tasks = await fanOut(
      targets,
      (t) => `${t.account}/${t.taskListId}`,
      (t) => this.listTasksFor(t.account, t.taskListId, params),
    );
    return params.completed === undefined ? tasks : tasks.filter((t) => t.completed === params.completed);
  }

  /**
   * Fetches and converts every page of tasks for a single account/task-list pair.
   */
  private async listTasksFor(account: string, taskListId: string, params: ListTasksParams): Promise<Task[]> {
    const pages = await this.caller.callAllPages(account, {
      path: ["tasks", "tasks", "list"],
      params: {
        tasklist: taskListId,
        showCompleted: true,
        showDeleted: false,
        showHidden: false,
        ...(params.dueAfter && { dueMin: toDueTimestamp(params.dueAfter) }),
        ...(params.dueBefore && { dueMax: toDueMaxTimestamp(params.dueBefore) }),
      },
    });
    const label = `${account}/${taskListId}`;
    const tagged = this.taggedTaskListId(account, taskListId);
    return pages.flatMap((page) => expectItems(page, "tasks.tasks.list", label)).map((raw) => toTask(raw, account, tagged));
  }

  /**
   * Returns taskListId only when `account` has extra task lists configured, keeping TaskView minimal for the
   * common single-list setup, mirroring GoogleCalendarAdapter's taggedCalendarId.
   */
  private taggedTaskListId(account: string, taskListId: string): string | undefined {
    const found = this.accounts.find((a) => a.name === account);
    return (found?.taskListIds.length ?? 0) > 0 ? taskListId : undefined;
  }
}

/**
 * Extracts and validates the `items` array from one page of `tasks.tasks.list`'s response envelope.
 * `items` is absent from the Tasks API discovery schema's required fields, so a page with no matching
 * tasks can omit it entirely rather than sending an empty array (docs/spikes/gws-cli-0.22.5.md §6); that
 * case is treated as zero tasks rather than an error.
 */
function expectItems(page: unknown, tool: string, label: string): unknown[] {
  if (typeof page !== "object" || page === null) {
    throw new Error(`${tool}: unexpected response for ${label}: ${JSON.stringify(page)}`);
  }
  const items = (page as Record<string, unknown>).items;
  if (items === undefined) return [];
  if (!Array.isArray(items)) {
    throw new Error(`${tool}: "items" is not an array for ${label}`);
  }
  return items;
}
