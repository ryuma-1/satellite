import { isStepCount, streamText, type LanguageModel, type ToolSet } from "ai";
import { type ConfirmFn, withWriteConfirmation } from "./write_confirmation_hook";

/**
 * Inputs for one question-answer run of the agent.
 */
export interface RunAgentOptions {
  /** Model that decides which tools to call (design_doc §1.2). */
  model: LanguageModel;
  /** Tools the model may call. */
  tools: ToolSet;
  /** System prompt. */
  instructions: string;
  /** The user's request. */
  prompt: string;
  /** Upper bound on model steps, so a model that keeps calling tools cannot loop forever. */
  maxSteps?: number;
  /**
   * Called when a tool throws. The error is also sent back to the model, which usually recovers,
   * so this is for visibility rather than control flow.
   */
  onToolError?: (toolName: string, error: unknown) => void;
  /**
   * Tool names withWriteConfirmation should guard before `tools` reaches streamText; defaults to
   * DEFAULT_GUARDED_TOOLS. Overriding this here, rather than requiring every caller to wrap `tools` itself,
   * is what makes the confirmation structurally unavoidable regardless of how the model calls a write tool
   * (issue #9).
   */
  guardedToolNames?: readonly string[];
  /** Confirmation function passed to withWriteConfirmation; defaults to promptConfirm. */
  confirm?: ConfirmFn;
}

/**
 * Runs the tool-use loop and yields the answer text as it streams (design_doc §5.2).
 * Reads `stream` rather than `textStream` because the latter drops error parts,
 * which would turn e.g. an invalid API key into a silent empty answer.
 */
export async function* runAgent(options: RunAgentOptions): AsyncGenerator<string> {
  const result = streamText({
    model: options.model,
    // Wrapped here, not by each caller, so a write tool cannot reach streamText unconfirmed regardless of
    // how index.ts (or a future caller) assembles `tools` (issue #9's "LLMがどう呼んでもスキップできない").
    tools: withWriteConfirmation(options.tools, { toolNames: options.guardedToolNames, confirm: options.confirm }),
    instructions: options.instructions,
    prompt: options.prompt,
    stopWhen: isStepCount(options.maxSteps ?? 10),
    // The default handler logs to the console; errors are rethrown from the loop below instead,
    // so logging here too would print every failure twice.
    onError: () => {},
  });

  for await (const part of result.stream) {
    switch (part.type) {
      case "text-delta":
        yield part.text;
        break;
      case "tool-error":
        options.onToolError?.(part.toolName, part.error);
        break;
      case "error":
        throw part.error instanceof Error ? part.error : new Error(String(part.error));
    }
  }
}
