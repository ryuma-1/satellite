import { tool, type ToolSet } from "ai";
import { z } from "zod";

/**
 * Asks the user to approve or reject a proposed action, returning true for approval.
 * Injectable so callers (and their tests) never need to touch stdin directly (see promptConfirm for the
 * default, stdin-backed implementation).
 */
export type ConfirmFn = (message: string) => boolean;

/**
 * Default ConfirmFn: shows `message` and reads a y/n answer from stdin via Bun's blocking global `prompt()`.
 * Anything other than a leading "y"/"Y" — including a `null` result, which `prompt()` returns on EOF/a
 * non-interactive stdin — is treated as a rejection, so an ambiguous or unavailable terminal never
 * accidentally approves an action.
 *
 * This blocks the whole process on stdin (design decision, issue #7): satellite's CLI answers one request per
 * process invocation with no persisted conversation state, so pausing the in-flight tool loop to read a
 * terminal answer is the only way to get a mid-run confirmation without a larger architecture change. This is
 * a deliberate, narrow exception to "tools are simple CRUD/side effects only" (see the implementation plan's
 * risk notes); it also means this tool cannot be used from a non-interactive/piped invocation.
 */
export function promptConfirm(message: string): boolean {
  const answer = prompt(`${message}\n[y/N] `);
  return answer !== null && /^y/i.test(answer.trim());
}

/**
 * Wraps a user confirmation step as an AI SDK tool (design_doc §5.3 pattern), so the agent can pause before
 * an action it should not take without approval (e.g. create_task) and require an explicit yes/no.
 * @param confirm Confirmation function; defaults to promptConfirm. Tests inject a fake so they never touch stdin.
 */
export function createConfirmationTools(confirm: ConfirmFn = promptConfirm): ToolSet {
  return {
    request_confirmation: tool({
      description:
        "Ask the user to approve or reject a proposed action before taking it. `summary` must contain the " +
        "full proposal (e.g. for a task: title, suggested due date, and any subtask breakdown). Only proceed " +
        "with the action (e.g. call create_task) when this tool returns approved: true.",
      inputSchema: z.object({
        summary: z.string().describe("Full text of the proposal to show the user, in the answer's own language"),
      }),
      execute: async ({ summary }) => {
        return { approved: confirm(summary) };
      },
    }),
  };
}
