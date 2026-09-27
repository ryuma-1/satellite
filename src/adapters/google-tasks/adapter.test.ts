import { describe, expect, test } from "bun:test";
import type { GwsCaller, GwsRequest } from "../../gws/runner";
import { GoogleTasksAdapter } from "./adapter";
import emptyFixture from "./fixtures/list-empty-tasks.json";
import fixture from "./fixtures/list-tasks.json";

/**
 * Computes a fake response from the call, so multi-page/multi-account/multi-list tests can answer per call.
 */
type Responder = (account: string, req: GwsRequest) => unknown;

/**
 * Records gws calls and replies with a canned or computed response, mirroring the calendar adapter's FakeCaller.
 */
class FakeCaller implements GwsCaller {
  /** Every call made through this caller, in order, for assertions on what the adapter requested. */
  readonly calls: { account: string; req: GwsRequest }[] = [];

  /**
   * @param response Value returned from every call, or a Responder computing it per call.
   */
  constructor(private readonly response: unknown) {}

  /** Not used by GoogleTasksAdapter (list always pages), but required by the GwsCaller interface. */
  async call(account: string, req: GwsRequest): Promise<unknown> {
    this.calls.push({ account, req });
    return this.respond(account, req);
  }

  /** Records the call and returns the response, wrapped as a single page unless it is already one page per call. */
  async callAllPages(account: string, req: GwsRequest): Promise<unknown[]> {
    this.calls.push({ account, req });
    const result = this.respond(account, req);
    return Array.isArray(result) ? result : [result];
  }

  private respond(account: string, req: GwsRequest): unknown {
    return typeof this.response === "function" ? (this.response as Responder)(account, req) : this.response;
  }
}

describe("GoogleTasksAdapter", () => {
  test("listTasks queries the default list with the fixed fetch flags", async () => {
    const caller = new FakeCaller(fixture);
    const tasks = await new GoogleTasksAdapter(caller, { accounts: ["acct"] }).listTasks();

    expect(caller.calls).toEqual([
      {
        account: "acct",
        req: {
          path: ["tasks", "tasks", "list"],
          params: { tasklist: "@default", showCompleted: true, showDeleted: false, showHidden: false },
        },
      },
    ]);
    expect(tasks.map((t) => [t.id, t.account, t.taskListId])).toEqual([
      ["task_open_001", "acct", undefined],
      ["task_done_002", "acct", undefined],
    ]);
  });

  test("listTasks forwards dueAfter/dueBefore as dueMin/dueMax", async () => {
    const caller = new FakeCaller({ items: [] });
    await new GoogleTasksAdapter(caller, { accounts: ["acct"] }).listTasks({
      dueAfter: new Date(2026, 8, 24),
      dueBefore: new Date(2026, 8, 30),
    });

    expect(caller.calls[0]?.req.params).toMatchObject({
      dueMin: "2026-09-24T00:00:00.000Z",
      dueMax: "2026-09-30T00:00:00.000Z",
    });
  });

  test("listTasks rounds dueMax up to the next day for a timed dueBefore, so that day's tasks aren't excluded", async () => {
    const timed = new FakeCaller({ items: [] });
    await new GoogleTasksAdapter(timed, { accounts: ["acct"] }).listTasks({ dueBefore: new Date(2026, 8, 30, 15, 0, 0) });
    expect(timed.calls[0]?.req.params?.dueMax).toBe("2026-10-01T00:00:00.000Z");

    // An exact local midnight is left as-is: "before 2026-09-30 00:00" still excludes the 30th entirely.
    const midnight = new FakeCaller({ items: [] });
    await new GoogleTasksAdapter(midnight, { accounts: ["acct"] }).listTasks({ dueBefore: new Date(2026, 8, 30) });
    expect(midnight.calls[0]?.req.params?.dueMax).toBe("2026-09-30T00:00:00.000Z");
  });

  test("listTasks filters by completion state client-side, after fetching every task", async () => {
    const caller = new FakeCaller(fixture);
    const completed = await new GoogleTasksAdapter(caller, { accounts: ["acct"] }).listTasks({ completed: true });
    expect(completed.map((t) => t.id)).toEqual(["task_done_002"]);

    // gws is still asked for everything (showCompleted: true), since it has no "completed only" mode.
    expect(caller.calls[0]?.req.params).toMatchObject({ showCompleted: true });
  });

  test("listTasks merges every NDJSON page", async () => {
    const caller = new FakeCaller([
      { items: [{ id: "t1", title: "First", status: "needsAction" }], nextPageToken: "p2" },
      { items: [{ id: "t2", title: "Second", status: "needsAction" }] },
    ]);
    const tasks = await new GoogleTasksAdapter(caller, { accounts: ["acct"] }).listTasks();
    expect(tasks.map((t) => t.id)).toEqual(["t1", "t2"]);
  });

  test("listTasks treats a page with no items key as an empty list, not an error", async () => {
    const caller = new FakeCaller(emptyFixture);
    const tasks = await new GoogleTasksAdapter(caller, { accounts: ["acct"] }).listTasks();
    expect(tasks).toEqual([]);
  });

  test("listTasks fails loudly on unexpected response", async () => {
    const adapter = new GoogleTasksAdapter(new FakeCaller("plain text"), { accounts: ["acct"] });
    await expect(adapter.listTasks()).rejects.toThrow('unexpected response for acct/@default');
  });

  test("requires at least one account", () => {
    expect(() => new GoogleTasksAdapter(new FakeCaller({}), { accounts: [] })).toThrow(
      "requires at least one account",
    );
  });
});

describe("GoogleTasksAdapter with multiple accounts", () => {
  const accounts = ["personal", "school"];

  /** Builds a single-task list-tasks response for the given id. */
  const listResponse = (id: string, title: string) => ({ items: [{ id, title, status: "needsAction" }] });

  test("listTasks queries every account and tags tasks with account", async () => {
    const caller = new FakeCaller((account: string) =>
      account === "personal" ? listResponse("p1", "Personal task") : listResponse("s1", "School task"),
    );
    const tasks = await new GoogleTasksAdapter(caller, { accounts }).listTasks();

    expect(caller.calls.map((c) => c.account)).toEqual(["personal", "school"]);
    expect(tasks.map((t) => [t.id, t.account])).toEqual([
      ["p1", "personal"],
      ["s1", "school"],
    ]);
  });

  test("listTasks names every failing account instead of returning partial results", async () => {
    const caller = new FakeCaller((account: string) => {
      if (account === "school") throw new Error("token expired");
      return listResponse("p1", "Personal task");
    });
    await expect(new GoogleTasksAdapter(caller, { accounts }).listTasks()).rejects.toThrow(
      "school/@default: token expired",
    );
  });
});

describe("GoogleTasksAdapter with multiple task lists", () => {
  const perAccount = ["normal", { name: "school", taskListIds: ["work-list"] }];

  /** Builds a single-task list-tasks response for the given id. */
  const listResponse = (id: string, title: string) => ({ items: [{ id, title, status: "needsAction" }] });

  test("listTasks queries every task list and tags tasks with taskListId only where extras are configured", async () => {
    const caller = new FakeCaller((_account: string, req: GwsRequest) =>
      req.params?.tasklist === "@default" ? listResponse("d1", "Default task") : listResponse("w1", "Work task"),
    );
    const tasks = await new GoogleTasksAdapter(caller, { accounts: perAccount }).listTasks();

    expect(caller.calls.map((c) => [c.account, c.req.params?.tasklist])).toEqual([
      ["normal", "@default"],
      ["school", "@default"],
      ["school", "work-list"],
    ]);
    expect(tasks.map((t) => [t.id, t.account, t.taskListId])).toEqual([
      ["d1", "normal", undefined],
      ["d1", "school", "@default"],
      ["w1", "school", "work-list"],
    ]);
  });

  test("listTasks names every failing task list instead of returning partial results", async () => {
    const caller = new FakeCaller((_account: string, req: GwsRequest) => {
      if (req.params?.tasklist === "work-list") throw new Error("not found");
      return listResponse("d1", "Default task");
    });
    await expect(new GoogleTasksAdapter(caller, { accounts: perAccount }).listTasks()).rejects.toThrow(
      "school/work-list: not found",
    );
  });
});
