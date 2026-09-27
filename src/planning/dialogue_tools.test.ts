import { describe, expect, test } from "bun:test";
import type { ToolExecutionOptions } from "ai";
import { type AskUserFn, createDialogueTools } from "./dialogue_tools";

/**
 * Minimal execution options; the tool under test does not use them.
 */
const execOptions = { toolCallId: "call1", messages: [] } as unknown as ToolExecutionOptions<never>;

/**
 * Invokes a tool's execute function, failing the test if the tool has none, mirroring
 * write_confirmation_hook.test.ts's `run` helper.
 */
async function run(tools: ReturnType<typeof createDialogueTools>, name: string, input: unknown): Promise<unknown> {
  const execute = tools[name]?.execute;
  if (!execute) throw new Error(`tool ${name} has no execute`);
  return await execute(input as never, execOptions);
}

describe("createDialogueTools", () => {
  test("returns answered: true and the answer from ask", async () => {
    const ask: AskUserFn = () => "Buy milk";
    const result = await run(createDialogueTools(ask), "ask_user", { question: "What is the task's title?" });
    expect(result).toEqual({ answered: true, answer: "Buy milk" });
  });

  test("returns answered: false, with no answer field, when ask returns undefined (e.g. EOF)", async () => {
    const ask: AskUserFn = () => undefined;
    const result = await run(createDialogueTools(ask), "ask_user", { question: "What is the task's title?" });
    expect(result).toEqual({ answered: false });
    expect(result).not.toHaveProperty("answer");
  });

  test("passes the question through to ask unchanged", async () => {
    let seen: string | undefined;
    const ask: AskUserFn = (question) => {
      seen = question;
      return "answer";
    };
    await run(createDialogueTools(ask), "ask_user", { question: "締切はいつですか？" });
    expect(seen).toBe("締切はいつですか？");
  });
});
