import { isStepCount, streamText, type LanguageModel, type ToolSet } from "ai";

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
}

/**
 * Runs the tool-use loop and yields the answer text as it streams (design_doc §5.2).
 * Reads `stream` rather than `textStream` because the latter drops error parts,
 * which would turn e.g. an invalid API key into a silent empty answer.
 */
export async function* runAgent(options: RunAgentOptions): AsyncGenerator<string> {
  const result = streamText({
    model: options.model,
    tools: options.tools,
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
