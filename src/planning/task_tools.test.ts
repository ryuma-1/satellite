import { describe, expect, test } from "bun:test";
import type { ToolExecutionOptions } from "ai";
import type { ListTasksParams, Task, TaskService } from "../services/tasks";
import { formatLocalDateTime } from "./datetime";
import { createTaskTools, resolveAccountTaskLists, toTaskView } from "./task_tools";

/**
 * Records service calls and replies with fixed tasks, mirroring FakeCalendar in calendar_tools.test.ts.
 */
class FakeTaskService implements TaskService {
  /** Every call made to this fake, in order, for assertions on what the tool passed through. */
  readonly calls: { method: string; args: unknown[] }[] = [];

  /**
   * @param tasks Tasks returned from every listTasks call.
   */
  constructor(private readonly tasks: Task[]) {}

  /** Records the call and returns the canned tasks. */
  async listTasks(params?: ListTasksParams): Promise<Task[]> {
    this.calls.push({ method: "listTasks", args: [params] });
    return this.tasks;
  }
}

/** An open (not completed) task with a due date and notes, shared across the tests below. */
const openTask: Task = {
  id: "task1",
  title: "Buy milk",
  completed: false,
  due: new Date(2026, 8, 30),
  notes: "2%",
};

/** A completed task without a due date or notes, shared across the tests below. */
const doneTask: Task = {
  id: "task2",
  title: "Submit report",
  completed: true,
};

/**
 * Minimal execution options; the tools under test do not use them.
 */
const execOptions = { toolCallId: "call1", messages: [] } as unknown as ToolExecutionOptions<never>;

/**
 * Invokes a tool's execute function, failing the test if the tool has none.
 */
async function run(tools: ReturnType<typeof createTaskTools>, name: string, input: unknown): Promise<unknown> {
  const execute = tools[name]?.execute;
  if (!execute) throw new Error(`tool ${name} has no execute`);
  return await execute(input as never, execOptions);
}

describe("toTaskView", () => {
  test("formats the due date as YYYY-MM-DD and omits absent fields", () => {
    expect(toTaskView(openTask)).toEqual({
      id: "task1",
      title: "Buy milk",
      completed: false,
      due: "2026-09-30",
      notes: "2%",
    });
    expect(toTaskView(doneTask)).toEqual({ id: "task2", title: "Submit report", completed: true });
    expect(toTaskView(doneTask)).not.toHaveProperty("due");
    expect(toTaskView(doneTask)).not.toHaveProperty("notes");
  });

  test("tags the view with taskListId when the task carries one", () => {
    expect(toTaskView({ ...openTask, taskListId: "work-list" }).taskListId).toBe("work-list");
    expect(toTaskView(openTask)).not.toHaveProperty("taskListId");
  });

  test("tags the view with account when the task carries one", () => {
    expect(toTaskView({ ...openTask, account: "school" }).account).toBe("school");
    expect(toTaskView(openTask)).not.toHaveProperty("account");
  });
});

/** A single account with just the default task list, used by tests that don't exercise multi-account scope. */
const defaultOnly = [{ name: "acct", taskListIds: ["@default"] }];

describe("createTaskTools", () => {
  test("list_tasks parses the range and completion filter, and returns views", async () => {
    const service = new FakeTaskService([openTask, doneTask]);
    const tools = createTaskTools(service, defaultOnly);

    const result = await run(tools, "list_tasks", {
      dueAfter: "2026-09-24T00:00:00+09:00",
      dueBefore: "2026-10-01",
      completed: false,
    });

    const params = service.calls[0]?.args[0] as ListTasksParams;
    expect(params.dueAfter?.toISOString()).toBe("2026-09-23T15:00:00.000Z");
    // Date-only dueBefore is inclusive of that day: it is advanced to local midnight of the *following*
    // day, since ListTasksParams.dueBefore itself treats exact local midnight as excluding its own day.
    expect(params.dueBefore?.getTime()).toBe(new Date(2026, 9, 2).getTime());
    expect(params.completed).toBe(false);
    expect(result).toEqual([openTask, doneTask].map(toTaskView));
  });

  test("date-only dueBefore includes that entire day (inclusive semantics)", async () => {
    const service = new FakeTaskService([]);
    const tools = createTaskTools(service, defaultOnly);

    await run(tools, "list_tasks", { dueBefore: "2026-09-30" });

    const params = service.calls[0]?.args[0] as ListTasksParams;
    // Advanced one day forward so the adapter's exact-local-midnight ("exclude this day") rule instead
    // excludes the *following* day, leaving the 30th included.
    expect(params.dueBefore?.getTime()).toBe(new Date(2026, 9, 1).getTime());
  });

  test("timed dueBefore is passed through unchanged, relying on the adapter's own round-up", async () => {
    const service = new FakeTaskService([]);
    const tools = createTaskTools(service, defaultOnly);

    await run(tools, "list_tasks", { dueBefore: "2026-09-30T15:00:00+09:00" });

    const params = service.calls[0]?.args[0] as ListTasksParams;
    expect(params.dueBefore?.toISOString()).toBe("2026-09-30T06:00:00.000Z");
  });

  test("timed dueBefore at exact local midnight is also passed through unchanged (excludes that day)", async () => {
    const service = new FakeTaskService([]);
    const tools = createTaskTools(service, defaultOnly);
    // Built from the host's own local offset (rather than a hardcoded "+09:00") so this exercises exact
    // local midnight regardless of which timezone the test runs in.
    const midnight = new Date(2026, 8, 30);

    await run(tools, "list_tasks", { dueBefore: formatLocalDateTime(midnight) });

    const params = service.calls[0]?.args[0] as ListTasksParams;
    expect(params.dueBefore?.getTime()).toBe(midnight.getTime());
  });

  test("date-only dueAfter is local midnight of that day (inclusive by construction)", async () => {
    const service = new FakeTaskService([]);
    const tools = createTaskTools(service, defaultOnly);

    await run(tools, "list_tasks", { dueAfter: "2026-09-24" });

    const params = service.calls[0]?.args[0] as ListTasksParams;
    expect(params.dueAfter?.getTime()).toBe(new Date(2026, 8, 24).getTime());
  });

  test("timed dueAfter keeps its own local date, still inclusive of that day", async () => {
    const service = new FakeTaskService([]);
    const tools = createTaskTools(service, defaultOnly);

    await run(tools, "list_tasks", { dueAfter: "2026-09-24T15:00:00+09:00" });

    const params = service.calls[0]?.args[0] as ListTasksParams;
    expect(params.dueAfter?.toISOString()).toBe("2026-09-24T06:00:00.000Z");
  });

  test("list_tasks without filters passes undefined bounds and completed", async () => {
    const service = new FakeTaskService([openTask]);
    await run(createTaskTools(service, defaultOnly), "list_tasks", {});
    expect(service.calls[0]?.args[0]).toEqual({ dueBefore: undefined, dueAfter: undefined, completed: undefined });
  });

  test("rejects unparseable dates with a message the LLM can act on", async () => {
    const service = new FakeTaskService([openTask]);
    const tools = createTaskTools(service, defaultOnly);
    await expect(run(tools, "list_tasks", { dueAfter: "next friday" })).rejects.toThrow(/dueAfter.*ISO 8601/);
    expect(service.calls).toHaveLength(0);
  });

  test("mentions every account/task-list combination only when there is more than the single default", () => {
    const single = createTaskTools(new FakeTaskService([]), defaultOnly).list_tasks?.description ?? "";
    const multiList = createTaskTools(new FakeTaskService([]), [{ name: "acct", taskListIds: ["@default", "work-list"] }])
      .list_tasks?.description ?? "";
    const multiAccount = createTaskTools(new FakeTaskService([]), [
      { name: "personal", taskListIds: ["@default"] },
      { name: "school", taskListIds: ["@default"] },
    ]).list_tasks?.description ?? "";

    expect(single).not.toContain("Merges tasks across");
    expect(multiList).toContain("acct: @default, work-list");
    expect(multiAccount).toContain("personal: @default; school: @default");
  });
});

describe("resolveAccountTaskLists", () => {
  test("prefixes each account's extras with the default task list", () => {
    const accountTaskLists = resolveAccountTaskLists(
      [
        { name: "personal", taskListIds: [] },
        { name: "school", taskListIds: ["work-list"] },
      ],
      "@default",
    );
    expect(accountTaskLists).toEqual([
      { name: "personal", taskListIds: ["@default"] },
      { name: "school", taskListIds: ["@default", "work-list"] },
    ]);
  });

  test("de-duplicates nothing beyond what the config layer already guarantees unique", () => {
    const accountTaskLists = resolveAccountTaskLists([{ name: "acct", taskListIds: ["work-list"] }], "@default");
    expect(accountTaskLists).toEqual([{ name: "acct", taskListIds: ["@default", "work-list"] }]);
  });
});
