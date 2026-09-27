import { describe, expect, test } from "bun:test";
import { tool, type ToolExecutionOptions } from "ai";
import { z } from "zod";
import { type ConfirmFn, DEFAULT_GUARDED_TOOLS, withWriteConfirmation } from "./write_confirmation_hook";

/**
 * Minimal execution options; the tools under test do not use them.
 */
const execOptions = { toolCallId: "call1", messages: [] } as unknown as ToolExecutionOptions<never>;

/**
 * Invokes a tool's execute function, failing the test if the tool has none.
 */
async function run(tools: ReturnType<typeof withWriteConfirmation>, name: string, input: unknown): Promise<unknown> {
  const execute = tools[name]?.execute;
  if (!execute) throw new Error(`tool ${name} has no execute`);
  return await execute(input as never, execOptions);
}

/**
 * A fake create_task tool that records whether its execute ran, mirroring task_tools.ts's create_task shape
 * closely enough to exercise the default summarize template.
 */
function fakeCreateTask(calls: unknown[]) {
  return tool({
    description: "fake create_task",
    inputSchema: z.object({ title: z.string(), due: z.string().optional() }),
    execute: async (input) => {
      calls.push(input);
      return { id: "created1", ...input };
    },
  });
}

/**
 * A fake tool outside DEFAULT_GUARDED_TOOLS, to verify pass-through behavior.
 */
function fakeListTasks(calls: unknown[]) {
  return tool({
    description: "fake list_tasks",
    inputSchema: z.object({}),
    execute: async (input) => {
      calls.push(input);
      return [];
    },
  });
}

describe("withWriteConfirmation", () => {
  test("calls the original execute and returns its result when confirm approves", async () => {
    const calls: unknown[] = [];
    const confirm: ConfirmFn = () => true;
    const tools = withWriteConfirmation({ create_task: fakeCreateTask(calls) }, { confirm });

    const result = await run(tools, "create_task", { title: "Buy milk" });

    expect(calls).toEqual([{ title: "Buy milk" }]);
    expect(result).toEqual({ id: "created1", title: "Buy milk" });
  });

  test("never calls the original execute and returns confirmed: false when confirm rejects", async () => {
    const calls: unknown[] = [];
    const confirm: ConfirmFn = () => false;
    const tools = withWriteConfirmation({ create_task: fakeCreateTask(calls) }, { confirm });

    const result = await run(tools, "create_task", { title: "Buy milk" });

    expect(calls).toEqual([]);
    expect(result).toEqual({ confirmed: false });
  });

  test("passes the summarized message through to confirm", async () => {
    const calls: unknown[] = [];
    let seen: string | undefined;
    const confirm: ConfirmFn = (message) => {
      seen = message;
      return true;
    };
    const tools = withWriteConfirmation({ create_task: fakeCreateTask(calls) }, { confirm });

    await run(tools, "create_task", { title: "Buy milk", due: "2026-10-01" });

    expect(seen).toContain('Create task "Buy milk"');
    expect(seen).toContain("Due: 2026-10-01");
  });

  test("passes tools outside the guarded list through unchanged, without asking for confirmation", async () => {
    const calls: unknown[] = [];
    let confirmCalls = 0;
    const confirm: ConfirmFn = () => {
      confirmCalls++;
      return true;
    };
    const tools = withWriteConfirmation({ list_tasks: fakeListTasks(calls) }, { confirm });

    const result = await run(tools, "list_tasks", {});

    expect(confirmCalls).toBe(0);
    expect(calls).toEqual([{}]);
    expect(result).toEqual([]);
  });

  test("guards every tool in DEFAULT_GUARDED_TOOLS by default", async () => {
    for (const name of DEFAULT_GUARDED_TOOLS) {
      const calls: unknown[] = [];
      const original = tool({
        inputSchema: z.object({}),
        execute: async (input) => {
          calls.push(input);
          return { ok: true };
        },
      });

      // Rejection: confirm is called, but the original execute must not run.
      let confirmCalls = 0;
      const rejecting = withWriteConfirmation({ [name]: original }, { confirm: () => ((confirmCalls++), false) });
      const rejectedResult = await run(rejecting, name, {});
      expect(confirmCalls).toBe(1);
      expect(calls).toEqual([]);
      expect(rejectedResult).toEqual({ confirmed: false });

      // Approval: confirm is called, and the original execute now runs.
      confirmCalls = 0;
      const approving = withWriteConfirmation({ [name]: original }, { confirm: () => ((confirmCalls++), true) });
      const approvedResult = await run(approving, name, {});
      expect(confirmCalls).toBe(1);
      expect(calls).toEqual([{}]);
      expect(approvedResult).toEqual({ ok: true });
    }
  });

  test("extends the guarded set with a custom toolNames list", async () => {
    const calls: unknown[] = [];
    const custom = tool({
      description: "custom write tool",
      inputSchema: z.object({ value: z.string() }),
      execute: async (input) => {
        calls.push(input);
        return { ok: true };
      },
    });
    const confirm: ConfirmFn = () => false;
    const tools = withWriteConfirmation({ custom_write: custom }, { toolNames: ["custom_write"], confirm });

    const result = await run(tools, "custom_write", { value: "x" });

    expect(calls).toEqual([]);
    expect(result).toEqual({ confirmed: false });
  });
});
