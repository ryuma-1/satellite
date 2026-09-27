import { describe, expect, test } from "bun:test";
import type { NewTask } from "../../services/tasks";
import fixture from "./fixtures/list-tasks.json";
import { toDueMaxTimestamp, toDueTimestamp, toInsertBody, toTask } from "./mapper";

describe("toTask", () => {
  test("maps an open task with a due date and notes", () => {
    const task = toTask(fixture.items[0]);
    expect(task).toEqual({
      id: "task_open_001",
      title: "Buy milk",
      completed: false,
      notes: "2%, not whole",
      due: new Date(2026, 8, 30),
    });
  });

  test("maps a completed task without a due date", () => {
    const task = toTask(fixture.items[1]);
    expect(task).toEqual({ id: "task_done_002", title: "Submit report", completed: true });
    expect(task).not.toHaveProperty("due");
    expect(task).not.toHaveProperty("notes");
  });

  test("tags the task with the given account", () => {
    expect(toTask(fixture.items[0], "school").account).toBe("school");
    expect(toTask(fixture.items[0])).not.toHaveProperty("account");
  });

  test("tags the task with the given taskListId", () => {
    expect(toTask(fixture.items[0], undefined, "work-list").taskListId).toBe("work-list");
    expect(toTask(fixture.items[0])).not.toHaveProperty("taskListId");
  });

  test("maps the parent field for a subtask", () => {
    const task = toTask({ id: "sub1", title: "Subtask", status: "needsAction", parent: "parent1" });
    expect(task.parent).toBe("parent1");
  });

  test("omits parent for a task without one", () => {
    expect(toTask(fixture.items[0])).not.toHaveProperty("parent");
  });

  // Regression test for the UTC-midnight boundary bug called out in the implementation plan: a naive
  // `new Date(due)` followed by local getters would read "2026-09-29" in timezones west of UTC.
  test("reads the due date's own YYYY-MM-DD part, not its UTC-shifted local equivalent", () => {
    const task = toTask({ id: "x", title: "x", status: "needsAction", due: "2026-09-30T00:00:00.000Z" });
    expect(task.due).toEqual(new Date(2026, 8, 30));
    expect(task.due?.getFullYear()).toBe(2026);
    expect(task.due?.getMonth()).toBe(8);
    expect(task.due?.getDate()).toBe(30);
  });

  test("rejects malformed tasks", () => {
    expect(() => toTask({ title: "no id", status: "needsAction" })).toThrow("Unexpected task shape");
    expect(() => toTask({ id: "x", title: "x", status: "needsAction", due: "not-a-date" })).toThrow(
      "Invalid due date",
    );
  });
});

describe("toDueTimestamp", () => {
  test("formats a local date as UTC midnight, the inverse of parseDueDate", () => {
    expect(toDueTimestamp(new Date(2026, 8, 30))).toBe("2026-09-30T00:00:00.000Z");
  });

  test("zero-pads month and day", () => {
    expect(toDueTimestamp(new Date(2026, 0, 5))).toBe("2026-01-05T00:00:00.000Z");
  });

  test("round-trips with toTask's due parsing", () => {
    const original = new Date(2026, 8, 30);
    const task = toTask({ id: "x", title: "x", status: "needsAction", due: toDueTimestamp(original) });
    expect(task.due).toEqual(original);
  });

  // due_min is inclusive by construction: only the Y/M/D components are used, so a timed dueAfter still
  // matches every task due that same day, regardless of its own time-of-day.
  test("ignores time-of-day, keeping a timed dueAfter inclusive of the day it falls on", () => {
    expect(toDueTimestamp(new Date(2026, 8, 30, 15, 30, 0))).toBe("2026-09-30T00:00:00.000Z");
  });
});

describe("toDueMaxTimestamp", () => {
  // Regression test for the due_max exclusivity bug: due_max is a "before" (exclusive) bound compared
  // against tasks' UTC-midnight `due` instant, so a plain toDueTimestamp() of a timed cutoff would exclude
  // tasks due that same day, even though the cutoff itself falls later that day.
  test("rounds a timed cutoff up to the next day, so tasks due that day are not excluded", () => {
    expect(toDueMaxTimestamp(new Date(2026, 8, 30, 15, 0, 0))).toBe("2026-10-01T00:00:00.000Z");
  });

  test("rounds up across a month/year boundary", () => {
    expect(toDueMaxTimestamp(new Date(2026, 11, 31, 23, 59, 59, 999))).toBe("2027-01-01T00:00:00.000Z");
  });

  test("leaves an exact local midnight cutoff as-is, excluding that day entirely", () => {
    expect(toDueMaxTimestamp(new Date(2026, 8, 30))).toBe("2026-09-30T00:00:00.000Z");
  });
});

describe("toInsertBody", () => {
  test("includes only title for a bare task", () => {
    const task: NewTask = { title: "Buy milk" };
    expect(toInsertBody(task)).toEqual({ title: "Buy milk" });
  });

  test("includes notes and a formatted due date when given", () => {
    const task: NewTask = { title: "Buy milk", notes: "2%", due: new Date(2026, 8, 30) };
    expect(toInsertBody(task)).toEqual({
      title: "Buy milk",
      notes: "2%",
      due: "2026-09-30T00:00:00.000Z",
    });
  });

  test("excludes parent, since gws expects it as a query parameter, not a body field", () => {
    const task: NewTask = { title: "Subtask", parent: "parent1" };
    expect(toInsertBody(task)).not.toHaveProperty("parent");
  });
});
