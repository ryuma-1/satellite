import { describe, expect, test } from "bun:test";
import type { LanguageModelV4StreamPart, LanguageModelV4StreamResult } from "@ai-sdk/provider";
import { tool } from "ai";
import { convertArrayToReadableStream, MockLanguageModelV4 } from "ai/test";
import { z } from "zod";
import { runAgent } from "./agent";

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};

/**
 * Wraps stream parts as a model stream result.
 */
function streamOf(parts: LanguageModelV4StreamPart[]): LanguageModelV4StreamResult {
  return { stream: convertArrayToReadableStream(parts) };
}

/**
 * A model step that calls `ping` once. A fresh stream is built per call because a ReadableStream can be read only once.
 */
function toolCallStep(): LanguageModelV4StreamResult {
  return streamOf([
    { type: "tool-call", toolCallId: "call1", toolName: "ping", input: JSON.stringify({ value: "hi" }) },
    { type: "finish", usage, finishReason: { unified: "tool-calls", raw: undefined } },
  ]);
}

/**
 * A model step that calls a tool named `create_task` once, to exercise runAgent's built-in write-confirmation
 * guard (see the "guards write tools" tests below).
 */
function createTaskStep(): LanguageModelV4StreamResult {
  return streamOf([
    { type: "tool-call", toolCallId: "call1", toolName: "create_task", input: JSON.stringify({ title: "Write report" }) },
    { type: "finish", usage, finishReason: { unified: "tool-calls", raw: undefined } },
  ]);
}

/**
 * A model step that answers with text.
 */
function textStep(text: string): LanguageModelV4StreamResult {
  return streamOf([
    { type: "text-start", id: "t1" },
    { type: "text-delta", id: "t1", delta: text },
    { type: "text-end", id: "t1" },
    { type: "finish", usage, finishReason: { unified: "stop", raw: undefined } },
  ]);
}

/**
 * Drains the agent's output into one string.
 */
async function collect(chunks: AsyncIterable<string>): Promise<string> {
  let text = "";
  for await (const chunk of chunks) text += chunk;
  return text;
}

describe("runAgent", () => {
  test("executes tool calls and streams the final answer", async () => {
    const received: string[] = [];
    const model = new MockLanguageModelV4({ doStream: [toolCallStep(), textStep("done")] });
    const tools = {
      ping: tool({
        inputSchema: z.object({ value: z.string() }),
        execute: async ({ value }) => {
          received.push(value);
          return "pong";
        },
      }),
    };

    const text = await collect(runAgent({ model, tools, instructions: "sys", prompt: "q" }));

    expect(text).toBe("done");
    expect(received).toEqual(["hi"]);
    expect(model.doStreamCalls).toHaveLength(2);
    // The tool result must reach the model in the second step.
    expect(JSON.stringify(model.doStreamCalls[1]?.prompt)).toContain("pong");
  });

  test("reports tool errors and lets the model continue", async () => {
    const errors: string[] = [];
    const model = new MockLanguageModelV4({ doStream: [toolCallStep(), textStep("recovered")] });
    const tools = {
      ping: tool({
        inputSchema: z.object({ value: z.string() }),
        execute: async (): Promise<string> => {
          throw new Error("boom");
        },
      }),
    };

    const text = await collect(
      runAgent({
        model,
        tools,
        instructions: "sys",
        prompt: "q",
        onToolError: (name, error) => errors.push(`${name}: ${(error as Error).message}`),
      }),
    );

    expect(text).toBe("recovered");
    expect(errors).toEqual(["ping: boom"]);
  });

  test("throws stream errors instead of returning an empty answer", async () => {
    const model = new MockLanguageModelV4({
      doStream: streamOf([{ type: "error", error: new Error("invalid api key") }]),
    });
    await expect(collect(runAgent({ model, tools: {}, instructions: "sys", prompt: "q" }))).rejects.toThrow(
      "invalid api key",
    );
  });

  test("stops after maxSteps even if the model keeps calling tools", async () => {
    const model = new MockLanguageModelV4({ doStream: [toolCallStep(), toolCallStep(), toolCallStep()] });
    const tools = {
      ping: tool({ inputSchema: z.object({ value: z.string() }), execute: async () => "pong" }),
    };
    await collect(runAgent({ model, tools, instructions: "sys", prompt: "q", maxSteps: 2 }));
    expect(model.doStreamCalls).toHaveLength(2);
  });

  describe("guards write tools regardless of the caller's own wiring", () => {
    test("runs the guarded tool's execute when confirm approves", async () => {
      const received: unknown[] = [];
      const model = new MockLanguageModelV4({ doStream: [createTaskStep(), textStep("done")] });
      const tools = {
        create_task: tool({
          inputSchema: z.object({ title: z.string() }),
          execute: async (input) => {
            received.push(input);
            return { id: "created1" };
          },
        }),
      };

      const text = await collect(runAgent({ model, tools, instructions: "sys", prompt: "q", confirm: () => true }));

      expect(text).toBe("done");
      expect(received).toEqual([{ title: "Write report" }]);
    });

    test("never runs the guarded tool's execute when confirm rejects, even though the caller passed the raw tool", async () => {
      const received: unknown[] = [];
      const model = new MockLanguageModelV4({ doStream: [createTaskStep(), textStep("cancelled")] });
      const tools = {
        create_task: tool({
          inputSchema: z.object({ title: z.string() }),
          execute: async (input) => {
            received.push(input);
            return { id: "created1" };
          },
        }),
      };

      const text = await collect(runAgent({ model, tools, instructions: "sys", prompt: "q", confirm: () => false }));

      expect(text).toBe("cancelled");
      expect(received).toEqual([]);
      // The tool result the model saw in its next step must reflect the rejection, not a fabricated success.
      expect(JSON.stringify(model.doStreamCalls[1]?.prompt)).toContain('"confirmed":false');
    });
  });
});
