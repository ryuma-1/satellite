import { describe, expect, test } from "bun:test";
import type { ToolExecutionOptions } from "ai";
import { z } from "zod";
import type { WorkingHours } from "../config/schedule_config";
import type {
  CalendarEvent,
  CalendarEventPatch,
  CalendarService,
  ListEventsParams,
  NewCalendarEvent,
} from "../services/calendar";
import type { ListTasksParams, NewTask, Task, TaskService } from "../services/tasks";
import { formatLocalDateTime } from "./datetime";
import { computeFreeSlotRange } from "./due_date_suggestion";
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

  /** Records the call and returns a Task built from the given input plus a canned id/completed. */
  async createTask(task: NewTask): Promise<Task> {
    this.calls.push({ method: "createTask", args: [task] });
    return { id: "created1", completed: false, ...task };
  }
}

/**
 * Records listEvents calls and replies with fixed events; the other CalendarService methods are unused by
 * task_tools (only find_free_slot reads from a CalendarService, via listEvents).
 */
class FakeCalendarService implements CalendarService {
  /** Every call made to this fake, in order. */
  readonly calls: { method: string; args: unknown[] }[] = [];

  /**
   * @param events Events returned from every listEvents call.
   */
  constructor(private readonly events: CalendarEvent[] = []) {}

  /** Records the call and returns the canned events. */
  async listEvents(params?: ListEventsParams): Promise<CalendarEvent[]> {
    this.calls.push({ method: "listEvents", args: [params] });
    return this.events;
  }

  /** Unused by task_tools; throws if a test unexpectedly reaches it. */
  async createEvent(_event: NewCalendarEvent): Promise<CalendarEvent> {
    throw new Error("createEvent is not used by task_tools");
  }

  /** Unused by task_tools; throws if a test unexpectedly reaches it. */
  async updateEvent(_id: string, _patch: CalendarEventPatch): Promise<CalendarEvent> {
    throw new Error("updateEvent is not used by task_tools");
  }

  /** Unused by task_tools; throws if a test unexpectedly reaches it. */
  async deleteEvent(_id: string): Promise<void> {
    throw new Error("deleteEvent is not used by task_tools");
  }
}

/** A CalendarService fake with no events, for tests that don't exercise find_free_slot's calendar reading. */
const noEvents = new FakeCalendarService([]);

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
    const tools = createTaskTools(service, defaultOnly, noEvents);

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
    const tools = createTaskTools(service, defaultOnly, noEvents);

    await run(tools, "list_tasks", { dueBefore: "2026-09-30" });

    const params = service.calls[0]?.args[0] as ListTasksParams;
    // Advanced one day forward so the adapter's exact-local-midnight ("exclude this day") rule instead
    // excludes the *following* day, leaving the 30th included.
    expect(params.dueBefore?.getTime()).toBe(new Date(2026, 9, 1).getTime());
  });

  test("timed dueBefore is passed through unchanged, relying on the adapter's own round-up", async () => {
    const service = new FakeTaskService([]);
    const tools = createTaskTools(service, defaultOnly, noEvents);

    await run(tools, "list_tasks", { dueBefore: "2026-09-30T15:00:00+09:00" });

    const params = service.calls[0]?.args[0] as ListTasksParams;
    expect(params.dueBefore?.toISOString()).toBe("2026-09-30T06:00:00.000Z");
  });

  test("timed dueBefore at exact local midnight is also passed through unchanged (excludes that day)", async () => {
    const service = new FakeTaskService([]);
    const tools = createTaskTools(service, defaultOnly, noEvents);
    // Built from the host's own local offset (rather than a hardcoded "+09:00") so this exercises exact
    // local midnight regardless of which timezone the test runs in.
    const midnight = new Date(2026, 8, 30);

    await run(tools, "list_tasks", { dueBefore: formatLocalDateTime(midnight) });

    const params = service.calls[0]?.args[0] as ListTasksParams;
    expect(params.dueBefore?.getTime()).toBe(midnight.getTime());
  });

  test("date-only dueAfter is local midnight of that day (inclusive by construction)", async () => {
    const service = new FakeTaskService([]);
    const tools = createTaskTools(service, defaultOnly, noEvents);

    await run(tools, "list_tasks", { dueAfter: "2026-09-24" });

    const params = service.calls[0]?.args[0] as ListTasksParams;
    expect(params.dueAfter?.getTime()).toBe(new Date(2026, 8, 24).getTime());
  });

  test("timed dueAfter keeps its own local date, still inclusive of that day", async () => {
    const service = new FakeTaskService([]);
    const tools = createTaskTools(service, defaultOnly, noEvents);

    await run(tools, "list_tasks", { dueAfter: "2026-09-24T15:00:00+09:00" });

    const params = service.calls[0]?.args[0] as ListTasksParams;
    expect(params.dueAfter?.toISOString()).toBe("2026-09-24T06:00:00.000Z");
  });

  test("list_tasks without filters passes undefined bounds and completed", async () => {
    const service = new FakeTaskService([openTask]);
    await run(createTaskTools(service, defaultOnly, noEvents), "list_tasks", {});
    expect(service.calls[0]?.args[0]).toEqual({ dueBefore: undefined, dueAfter: undefined, completed: undefined });
  });

  test("rejects unparseable dates with a message the LLM can act on", async () => {
    const service = new FakeTaskService([openTask]);
    const tools = createTaskTools(service, defaultOnly, noEvents);
    await expect(run(tools, "list_tasks", { dueAfter: "next friday" })).rejects.toThrow(/dueAfter.*ISO 8601/);
    expect(service.calls).toHaveLength(0);
  });

  test("mentions every account/task-list combination only when there is more than the single default", () => {
    const single = createTaskTools(new FakeTaskService([]), defaultOnly, noEvents).list_tasks?.description ?? "";
    const multiList = createTaskTools(new FakeTaskService([]), [{ name: "acct", taskListIds: ["@default", "work-list"] }], noEvents)
      .list_tasks?.description ?? "";
    const multiAccount =
      createTaskTools(
        new FakeTaskService([]),
        [
          { name: "personal", taskListIds: ["@default"] },
          { name: "school", taskListIds: ["@default"] },
        ],
        noEvents,
      ).list_tasks?.description ?? "";

    expect(single).not.toContain("Merges tasks across");
    expect(multiList).toContain("acct: @default, work-list");
    expect(multiAccount).toContain("personal: @default; school: @default");
  });

  describe("create_task", () => {
    test("creates a task with title/due/notes and returns the view", async () => {
      const service = new FakeTaskService([]);
      const tools = createTaskTools(service, defaultOnly, noEvents);

      const result = await run(tools, "create_task", { title: "Write report", due: "2026-10-01", notes: "draft" });

      const created = service.calls[0]?.args[0] as NewTask;
      expect(created.title).toBe("Write report");
      expect(created.due?.getTime()).toBe(new Date(2026, 9, 1).getTime());
      expect(created.notes).toBe("draft");
      expect(result).toMatchObject({ id: "created1", title: "Write report", due: "2026-10-01", notes: "draft" });
    });

    test("records estimatedHours as an estimate marker in the notes", async () => {
      const service = new FakeTaskService([]);
      const tools = createTaskTools(service, defaultOnly, noEvents);

      await run(tools, "create_task", { title: "Write report", notes: "draft", estimatedHours: 3 });
      await run(tools, "create_task", { title: "No notes", estimatedHours: 1.5 });

      expect((service.calls[0]?.args[0] as NewTask).notes).toBe("draft\n[estimate: 3h]");
      expect((service.calls[1]?.args[0] as NewTask).notes).toBe("[estimate: 1.5h]");
    });

    test("passes parent through, to create a subtask", async () => {
      const service = new FakeTaskService([]);
      const tools = createTaskTools(service, defaultOnly, noEvents);

      await run(tools, "create_task", { title: "Subtask", parent: "parent1" });

      const created = service.calls[0]?.args[0] as NewTask;
      expect(created.parent).toBe("parent1");
    });

    test("without due/notes/parent leaves them undefined", async () => {
      const service = new FakeTaskService([]);
      const tools = createTaskTools(service, defaultOnly, noEvents);

      await run(tools, "create_task", { title: "Bare" });

      const created = service.calls[0]?.args[0] as NewTask;
      expect(created.due).toBeUndefined();
      expect(created.notes).toBeUndefined();
      expect(created.parent).toBeUndefined();
    });

    test("forwards the account/taskListId when given", async () => {
      const service = new FakeTaskService([]);
      const accountTaskLists = [{ name: "acct", taskListIds: ["@default", "work-list"] }];
      const tools = createTaskTools(service, accountTaskLists, noEvents);

      await run(tools, "create_task", { title: "Work item", account: "acct", taskListId: "work-list" });

      const created = service.calls[0]?.args[0] as NewTask;
      expect(created.account).toBe("acct");
      expect(created.taskListId).toBe("work-list");
    });

    test("taskListId argument is offered only when more than the default task list is configured", () => {
      const propertiesOf = (accountTaskLists: { name: string; taskListIds: string[] }[]) => {
        const schema = createTaskTools(new FakeTaskService([]), accountTaskLists, noEvents).create_task?.inputSchema;
        return (z.toJSONSchema(schema as z.ZodType) as { properties: Record<string, unknown> }).properties;
      };
      expect(propertiesOf(defaultOnly)).not.toHaveProperty("taskListId");
      expect(propertiesOf([{ name: "acct", taskListIds: ["@default", "work-list"] }]).taskListId).toMatchObject({
        enum: ["@default", "work-list"],
      });
    });
  });

  describe("check_task_draft", () => {
    test("passes the draft through to checkTaskDraft and returns its result", async () => {
      const service = new FakeTaskService([]);
      const tools = createTaskTools(service, defaultOnly, noEvents);

      const complete = await run(tools, "check_task_draft", {
        title: "Write report",
        estimatedHours: 2,
        deadline: "2026-10-01",
      });
      expect(complete).toEqual({ complete: true, missing: [] });

      const incomplete = await run(tools, "check_task_draft", { title: "Write report" });
      expect(incomplete).toEqual({ complete: false, missing: ["estimatedHours", "deadline"] });
    });
  });

  describe("find_free_slot", () => {
    test("bounds the calendar/task fetch to the deadline window and suggests a slot from it", async () => {
      const service = new FakeTaskService([]);
      const calendar = new FakeCalendarService([]);
      const fixedNow = new Date(2026, 8, 25, 9, 0, 0);
      const tools = createTaskTools(service, defaultOnly, calendar, { now: () => fixedNow });

      const result = await run(tools, "find_free_slot", { deadline: "2026-10-09" });

      // Fetches exactly the range findFreeSlot can draw a candidate from (see computeFreeSlotRange),
      // instead of an unbounded fetch of a user's entire event/task history.
      const range = computeFreeSlotRange(fixedNow, new Date(2026, 9, 9));
      expect(calendar.calls).toEqual([{ method: "listEvents", args: [{ from: range.start, to: range.end }] }]);
      const taskCall = service.calls.find((c) => c.method === "listTasks");
      expect(taskCall?.args[0]).toEqual({ dueAfter: range.start, dueBefore: range.end, completed: false });
      // 2026-09-25 is a Friday, so tomorrow (Sat 9/26) and Sun 9/27 are skipped; the first candidate weekday
      // is Monday 2026-09-28.
      expect(result).toEqual({
        date: "2026-09-28",
        slotStart: formatLocalDateTime(new Date(2026, 8, 28, 9, 0, 0)),
        freeHours: 9,
        tasksDueThatDay: 0,
        taskHours: 0,
        remainingHours: 9,
        fits: true,
      });
    });

    test("forwards estimatedHours to the underlying calculation, and a tight deadline exercises the fallback", async () => {
      const service = new FakeTaskService([]);
      // Monday 2026-09-28, the first weekday candidate, is fully booked; with the deadline bounded to that
      // same day there is no further candidate to fall back to, so this also exercises that fallback path.
      const busyEvents: CalendarEvent[] = [
        {
          id: "e1",
          title: "Busy",
          start: new Date(2026, 8, 28, 9, 0, 0),
          end: new Date(2026, 8, 28, 18, 0, 0),
          allDay: false,
        },
      ];
      const calendar = new FakeCalendarService(busyEvents);
      const fixedNow = new Date(2026, 8, 25, 9, 0, 0);
      const tools = createTaskTools(service, defaultOnly, calendar, { now: () => fixedNow });

      const result = await run(tools, "find_free_slot", { deadline: "2026-09-28", estimatedHours: 1 });

      // A deadline bounded to a single candidate day is reflected in the fetched range (narrower than a
      // distant deadline would produce)...
      const range = computeFreeSlotRange(fixedNow, new Date(2026, 8, 28));
      const distantRange = computeFreeSlotRange(fixedNow, new Date(2026, 9, 9));
      expect(calendar.calls).toEqual([{ method: "listEvents", args: [{ from: range.start, to: range.end }] }]);
      expect(range.end.getTime()).toBeLessThan(distantRange.end.getTime());
      // ...and in the result: with only one (fully booked) candidate day up to the deadline, it is returned
      // as the fallback rather than searching further.
      expect(result).toMatchObject({ date: "2026-09-28", freeHours: 0, tasksDueThatDay: 0, taskHours: 0, remainingHours: 0, fits: false });
    });

    test("schedules into the configured workingHours, for both the fetch window and the result", async () => {
      const service = new FakeTaskService([]);
      const calendar = new FakeCalendarService([]);
      const fixedNow = new Date(2026, 8, 25, 9, 0, 0);
      // Saturday-only working time (10:00-12:00), so the first candidate is tomorrow, Saturday 2026-09-26.
      const onlySaturday: WorkingHours = [[], [], [], [], [], [], [{ startMinutes: 600, endMinutes: 720 }]];
      const tools = createTaskTools(service, defaultOnly, calendar, { now: () => fixedNow, workingHours: onlySaturday });

      const result = await run(tools, "find_free_slot", { deadline: "2026-09-26" });

      const range = computeFreeSlotRange(fixedNow, new Date(2026, 8, 26));
      expect(calendar.calls).toEqual([{ method: "listEvents", args: [{ from: range.start, to: range.end }] }]);
      expect(result).toEqual({
        date: "2026-09-26",
        slotStart: formatLocalDateTime(new Date(2026, 8, 26, 10, 0, 0)),
        freeHours: 2,
        tasksDueThatDay: 0,
        taskHours: 0,
        remainingHours: 2,
        fits: true,
      });
    });

    test("rejects a deadline of today without fetching tasks/events (no candidate day exists)", async () => {
      const service = new FakeTaskService([]);
      const calendar = new FakeCalendarService([]);
      const fixedNow = new Date(2026, 8, 25, 9, 0, 0);
      const tools = createTaskTools(service, defaultOnly, calendar, { now: () => fixedNow });

      await expect(run(tools, "find_free_slot", { deadline: "2026-09-25" })).rejects.toThrow(
        /no working day between tomorrow and the deadline/,
      );
      expect(service.calls).toEqual([]);
      expect(calendar.calls).toEqual([]);
    });

    test("rejects a deadline in the past without fetching tasks/events", async () => {
      const service = new FakeTaskService([]);
      const calendar = new FakeCalendarService([]);
      const fixedNow = new Date(2026, 8, 25, 9, 0, 0);
      const tools = createTaskTools(service, defaultOnly, calendar, { now: () => fixedNow });

      await expect(run(tools, "find_free_slot", { deadline: "2026-09-20" })).rejects.toThrow(
        /no working day between tomorrow and the deadline/,
      );
      expect(service.calls).toEqual([]);
      expect(calendar.calls).toEqual([]);
    });

    test("rejects a deadline range that contains no working day at all, without fetching tasks/events", async () => {
      const service = new FakeTaskService([]);
      const calendar = new FakeCalendarService([]);
      const fixedNow = new Date(2026, 8, 25, 9, 0, 0);
      // No weekday has any working time, so even a distant deadline has zero candidate days.
      const noWorkingDays: WorkingHours = [[], [], [], [], [], [], []];
      const tools = createTaskTools(service, defaultOnly, calendar, { now: () => fixedNow, workingHours: noWorkingDays });

      await expect(run(tools, "find_free_slot", { deadline: "2026-10-09" })).rejects.toThrow(
        /no working day between tomorrow and the deadline/,
      );
      expect(service.calls).toEqual([]);
      expect(calendar.calls).toEqual([]);
    });
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
