import { tool, type ToolSet } from "ai";
import { z } from "zod";

/**
 * Asks the user a free-text question and returns their answer, or undefined when none was given.
 * Injectable so callers (and their tests) never need to touch stdin directly (see promptText for the
 * default, stdin-backed implementation), mirroring write_confirmation_hook.ts's ConfirmFn.
 */
export type AskUserFn = (question: string) => string | undefined;

/**
 * Default AskUserFn: shows `question` and reads one line of free text from stdin via Bun's blocking global
 * `prompt()`. Returns undefined on EOF/a non-interactive stdin (where `prompt()` itself returns `null`), so
 * callers (e.g. the task-creation Skill's ask_user loop) can tell "no answer available" apart from an
 * intentionally empty answer instead of treating both the same.
 *
 * This blocks the whole process on stdin, the same deliberate, narrow exception described in
 * write_confirmation_hook.ts's promptConfirm doc comment (design decision, issue #7, carried over to #9).
 */
export function promptText(question: string): string | undefined {
  const answer = prompt(question);
  return answer === null ? undefined : answer;
}

/**
 * Wraps a user dialogue step as an AI SDK tool, for the task-creation Skill's "ask until the draft is
 * complete" loop (skills/task-creation/SKILL.md) and any future Skill that needs to ask the user something
 * mid-run.
 * @param ask Dialogue function; defaults to promptText. Tests inject a fake so they never touch stdin.
 */
export function createDialogueTools(ask: AskUserFn = promptText): ToolSet {
  return {
    ask_user: tool({
      description:
        "Ask the user a free-text question and return their answer. Use this to fill in missing required " +
        "information (e.g. a task's title, estimated hours, or deadline) rather than guessing it. Returns " +
        "`{ answered: true, answer }` on a real reply, or `{ answered: false }` when none was obtained " +
        "(e.g. EOF/non-interactive stdin): stop and tell the user instead of asking again in that case.",
      inputSchema: z.object({
        question: z.string().describe("Question to show the user, in the answer's own language"),
      }),
      execute: async ({ question }) => {
        const answer = ask(question);
        // `answered: false` (rather than an omitted/undefined `answer`, which serializes to `{}`) lets the
        // LLM tell "no answer was given" apart from an actual empty-object result, so it stops asking again
        // instead of looping on a reply it cannot distinguish from "nothing came back".
        if (answer === undefined) {
          return { answered: false };
        }
        return { answered: true, answer };
      },
    }),
  };
}
