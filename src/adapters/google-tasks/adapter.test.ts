import { describe, expect, test } from "bun:test";
import type { McpToolCaller } from "../../mcp/client";
import { GoogleTasksAdapter } from "./adapter";
import fixture from "./fixtures/list-tasks.json";

/**
 * Computes a fake response from the tool call, so multi-page/multi-list tests can answer per call.
 */
type Responder = (name: string, args: Record<string, unknown>) => unknown;

/**
 * Records tool calls and replies with a canned or computed response, mirroring the calendar adapter's
 * FakeCaller.
 */
class FakeCaller implements McpToolCaller {
  /** Every call made through this caller, in order, for assertions on what the adapter requested. */
  readonly calls: { name: string; args: Record<string, unknown> }[] = [];

  /**
   * @param response Value returned from every call, or a Responder computing it per call.
   */
  constructor(private readonly response: unknown) {}

  /**
   * Records the call and returns the response. A thrown Responder error becomes a rejection.
   */
  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    this.calls.push({ name, args });
    return typeof this.response === "function" ? (this.response as Responder)(name, args) : this.response;
  }
}

describe("GoogleTasksAdapter", () => {
  test("listTasks queries the default list with the fixed fetch flags", async () => {
    const caller = new FakeCaller(fixture);
    const tasks = await new GoogleTasksAdapter(caller).listTasks();

    expect(caller.calls).toEqual([
      {
        name: "google_tasks_list_tasks",
        args: { tasklist_id: "@default", limit: 100, show_completed: true, show_deleted: false, show_hidden: false },
      },
    ]);
    expect(tasks.map((t) => t.id)).toEqual(["task_open_001", "task_done_002"]);
    expect(tasks[0]?.taskListId).toBeUndefined();
  });

  test("listTasks forwards dueAfter/dueBefore as due_min/due_max", async () => {
    const caller = new FakeCaller({ tasks: [], has_more: false });
    await new GoogleTasksAdapter(caller).listTasks({
      dueAfter: new Date(2026, 8, 24),
      dueBefore: new Date(2026, 8, 30),
    });

    expect(caller.calls[0]?.args).toMatchObject({
      due_min: "2026-09-24T00:00:00.000Z",
      due_max: "2026-09-30T00:00:00.000Z",
    });
  });

  test("listTasks rounds due_max up to the next day for a timed dueBefore, so that day's tasks aren't excluded", async () => {
    const timed = new FakeCaller({ tasks: [], has_more: false });
    await new GoogleTasksAdapter(timed).listTasks({ dueBefore: new Date(2026, 8, 30, 15, 0, 0) });
    expect(timed.calls[0]?.args.due_max).toBe("2026-10-01T00:00:00.000Z");

    // An exact local midnight is left as-is: "before 2026-09-30 00:00" still excludes the 30th entirely.
    const midnight = new FakeCaller({ tasks: [], has_more: false });
    await new GoogleTasksAdapter(midnight).listTasks({ dueBefore: new Date(2026, 8, 30) });
    expect(midnight.calls[0]?.args.due_max).toBe("2026-09-30T00:00:00.000Z");
  });

  test("listTasks filters by completion state client-side, after fetching every task", async () => {
    const caller = new FakeCaller(fixture);
    const completed = await new GoogleTasksAdapter(caller).listTasks({ completed: true });
    expect(completed.map((t) => t.id)).toEqual(["task_done_002"]);

    // The server is still asked for everything (show_completed: true), since it has no "completed only" mode.
    expect(caller.calls[0]?.args).toMatchObject({ show_completed: true });
  });

  test("listTasks follows next_page_token until has_more is false", async () => {
    const caller = new FakeCaller((_: string, args: Record<string, unknown>) =>
      args.page_token === undefined
        ? { tasks: [{ id: "t1", title: "First", status: "needsAction" }], has_more: true, next_page_token: "p2" }
        : { tasks: [{ id: "t2", title: "Second", status: "needsAction" }], has_more: false },
    );
    const tasks = await new GoogleTasksAdapter(caller).listTasks();

    expect(caller.calls.map((c) => c.args.page_token)).toEqual([undefined, "p2"]);
    expect(tasks.map((t) => t.id)).toEqual(["t1", "t2"]);
  });

  test("listTasks fails loudly on unexpected response", async () => {
    const adapter = new GoogleTasksAdapter(new FakeCaller("plain text"));
    await expect(adapter.listTasks()).rejects.toThrow('unexpected response for task list "@default"');
  });

  test("listTasks retries with a smaller limit instead of silently dropping tasks the server truncated", async () => {
    const seenLimits: number[] = [];
    const caller = new FakeCaller((_: string, args: Record<string, unknown>) => {
      seenLimits.push(args.limit as number);
      // The server would otherwise truncate down to a slice of `items` with no way to recover the rest,
      // so a large limit keeps failing until the adapter asks for few enough tasks to fit.
      if ((args.limit as number) > 25) {
        return {
          tasks: [{ id: "dropped", title: "Dropped", status: "needsAction" }],
          has_more: true,
          truncation_message: "Response truncated; narrow with a smaller limit or filters.",
        };
      }
      return { tasks: [{ id: "kept", title: "Kept", status: "needsAction" }], has_more: false };
    });

    const tasks = await new GoogleTasksAdapter(caller).listTasks();

    expect(tasks.map((t) => t.id)).toEqual(["kept"]);
    expect(seenLimits[0]).toBe(100);
    expect(seenLimits[seenLimits.length - 1]).toBeLessThanOrEqual(25);
  });

  test("listTasks retries a page truncated alongside a real next_page_token, instead of skipping its tasks", async () => {
    const caller = new FakeCaller((_: string, args: Record<string, unknown>) => {
      if (args.page_token === undefined) {
        if ((args.limit as number) > 1) {
          return {
            tasks: [{ id: "dropped", title: "Dropped", status: "needsAction" }],
            has_more: true,
            next_page_token: "p2",
            truncation_message: "Response truncated; narrow with a smaller limit or filters.",
          };
        }
        return { tasks: [{ id: "kept", title: "Kept", status: "needsAction" }], has_more: true, next_page_token: "p2" };
      }
      return { tasks: [{ id: "t2", title: "Second page", status: "needsAction" }], has_more: false };
    });

    const tasks = await new GoogleTasksAdapter(caller).listTasks();

    expect(tasks.map((t) => t.id)).toEqual(["kept", "t2"]);
  });

  test("listTasks fails loudly when a page keeps truncating even at the minimum limit", async () => {
    const caller = new FakeCaller({
      tasks: [{ id: "t1", title: "T1", status: "needsAction" }],
      has_more: true,
      truncation_message: "Response truncated; narrow with a smaller limit or filters.",
    });

    await expect(new GoogleTasksAdapter(caller).listTasks()).rejects.toThrow(
      "kept truncating its response even at limit=1",
    );
  });
});

describe("GoogleTasksAdapter with multiple task lists", () => {
  const taskListIds = ["work-list"];

  /**
   * Builds a single-task list-tasks response for the given id.
   */
  const listResponse = (id: string, title: string) => ({
    tasks: [{ id, title, status: "needsAction" }],
    has_more: false,
  });

  test("listTasks queries every task list and tags tasks with taskListId", async () => {
    const caller = new FakeCaller((_: string, args: Record<string, unknown>) =>
      args.tasklist_id === "@default" ? listResponse("d1", "Default task") : listResponse("w1", "Work task"),
    );
    const tasks = await new GoogleTasksAdapter(caller, { taskListIds }).listTasks();

    expect(caller.calls.map((c) => c.args.tasklist_id)).toEqual(["@default", "work-list"]);
    expect(tasks.map((t) => [t.id, t.taskListId])).toEqual([
      ["d1", "@default"],
      ["w1", "work-list"],
    ]);
  });

  test("listTasks names every failing task list instead of returning partial results", async () => {
    const caller = new FakeCaller((_: string, args: Record<string, unknown>) => {
      if (args.tasklist_id === "work-list") throw new Error("not found");
      return listResponse("d1", "Default task");
    });
    await expect(new GoogleTasksAdapter(caller, { taskListIds }).listTasks()).rejects.toThrow(
      "google_tasks_list_tasks failed for 1 task list(s):\nwork-list: not found",
    );
  });
});
