import { describe, expect, test } from "bun:test";
import type { ToolExecutionOptions } from "ai";
import { type ConfirmFn, createConfirmationTools } from "./confirmation_tools";

/**
 * Minimal execution options; the tool under test does not use them.
 */
const execOptions = { toolCallId: "call1", messages: [] } as unknown as ToolExecutionOptions<never>;

/**
 * Invokes a tool's execute function, failing the test if the tool has none, mirroring the `run` helper in
 * calendar_tools.test.ts / task_tools.test.ts.
 */
async function run(tools: ReturnType<typeof createConfirmationTools>, name: string, input: unknown): Promise<unknown> {
  const execute = tools[name]?.execute;
  if (!execute) throw new Error(`tool ${name} has no execute`);
  return await execute(input as never, execOptions);
}

describe("createConfirmationTools", () => {
  test("returns approved: true when confirm approves", async () => {
    const confirm: ConfirmFn = () => true;
    const result = await run(createConfirmationTools(confirm), "request_confirmation", { summary: "Create task X" });
    expect(result).toEqual({ approved: true });
  });

  test("returns approved: false when confirm rejects", async () => {
    const confirm: ConfirmFn = () => false;
    const result = await run(createConfirmationTools(confirm), "request_confirmation", { summary: "Create task X" });
    expect(result).toEqual({ approved: false });
  });

  test("passes the summary through to confirm unchanged", async () => {
    let seen: string | undefined;
    const confirm: ConfirmFn = (message) => {
      seen = message;
      return true;
    };
    await run(createConfirmationTools(confirm), "request_confirmation", {
      summary: "Title: Buy milk\nDue: 2026-10-01",
    });
    expect(seen).toBe("Title: Buy milk\nDue: 2026-10-01");
  });
});
