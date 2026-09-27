import type { ToolSet } from "ai";

/**
 * Asks the user to approve or reject a proposed action, returning true for approval.
 * Injectable so callers (and their tests) never need to touch stdin directly (see promptConfirm for the
 * default, stdin-backed implementation). Moved here from the now-removed confirmation_tools.ts: the
 * confirmation step itself now lives in this Hook rather than in an LLM-callable tool (issue #9).
 */
export type ConfirmFn = (message: string) => boolean;

/**
 * Default ConfirmFn: shows `message` and reads a y/n answer from stdin via Bun's blocking global `prompt()`.
 * Anything other than a leading "y"/"Y" — including a `null` result, which `prompt()` returns on EOF/a
 * non-interactive stdin — is treated as a rejection, so an ambiguous or unavailable terminal never
 * accidentally approves an action.
 *
 * This blocks the whole process on stdin (design decision, issue #7, carried over to issue #9): satellite's
 * CLI answers one request per process invocation with no persisted conversation state, so pausing the
 * in-flight tool loop to read a terminal answer is the only way to get a mid-run confirmation without a
 * larger architecture change. This is a deliberate, narrow exception to "tools are simple CRUD/side effects
 * only" (see the implementation plan's risk notes); it also means this cannot be used from a
 * non-interactive/piped invocation.
 */
export function promptConfirm(message: string): boolean {
  const answer = prompt(`${message}\n[y/N] `);
  return answer !== null && /^y/i.test(answer.trim());
}

/**
 * Tool names guarded by withWriteConfirmation when the caller does not override `options.toolNames`: every
 * write to a user's calendar or task list (issue #9's "書き込み系ツール"). Kept as a named constant, rather
 * than inlined, so callers can extend/replace it explicitly instead of duplicating the list.
 */
export const DEFAULT_GUARDED_TOOLS: readonly string[] = ["create_task", "create_event", "update_event", "delete_event"];

/**
 * Narrows `input` to a plain object for field lookups in the per-tool summarize templates below, so a
 * malformed/non-object input (which the tool's own zod schema should already have rejected before execute
 * runs) degrades to "no fields found" instead of throwing while building the confirmation message.
 */
function asRecord(input: unknown): Record<string, unknown> {
  return typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};
}

/**
 * Renders one optional field as a "  Label: value" line, omitted entirely when the field is absent, so the
 * confirmation message only shows what the tool call actually set.
 */
function field(label: string, value: unknown): string[] {
  return value !== undefined ? [`  ${label}: ${String(value)}`] : [];
}

/**
 * Human-readable summary for create_task, covering every field task_tools.ts's create_task accepts.
 */
function summarizeCreateTask(input: unknown): string {
  const { title, due, estimatedHours, notes, parent, account, taskListId } = asRecord(input);
  return [
    `Create task "${String(title)}"`,
    ...field("Due", due),
    ...field("Estimated hours", estimatedHours),
    ...field("Notes", notes),
    ...field("Parent task id", parent),
    ...field("Account", account),
    ...field("Task list", taskListId),
  ].join("\n");
}

/**
 * Human-readable summary for create_event, covering every field calendar_tools.ts's create_event accepts.
 */
function summarizeCreateEvent(input: unknown): string {
  const { title, start, end, allDay, description, location, account, calendarId } = asRecord(input);
  return [
    `Create event "${String(title)}"`,
    ...field("Start", start),
    ...field("End", end),
    ...field("All day", allDay),
    ...field("Description", description),
    ...field("Location", location),
    ...field("Account", account),
    ...field("Calendar", calendarId),
  ].join("\n");
}

/**
 * Human-readable summary for update_event, covering every field calendar_tools.ts's update_event accepts.
 */
function summarizeUpdateEvent(input: unknown): string {
  const { id, account, calendarId, title, start, end, allDay, description, location } = asRecord(input);
  return [
    `Update event ${String(id)}`,
    ...field("Account", account),
    ...field("Calendar", calendarId),
    ...field("New title", title),
    ...field("New start", start),
    ...field("New end", end),
    ...field("All day", allDay),
    ...field("New description", description),
    ...field("New location", location),
  ].join("\n");
}

/**
 * Human-readable summary for delete_event, covering every field calendar_tools.ts's delete_event accepts.
 */
function summarizeDeleteEvent(input: unknown): string {
  const { id, account, calendarId } = asRecord(input);
  return [`Delete event ${String(id)}`, ...field("Account", account), ...field("Calendar", calendarId)].join("\n");
}

/**
 * Per-tool summary templates, keyed by tool name, for the write tools guarded by default. A tool name not
 * listed here (e.g. a caller-supplied `toolNames` entry) falls back to the generic name+JSON rendering below.
 */
const SUMMARY_TEMPLATES: Record<string, (input: unknown) => string> = {
  create_task: summarizeCreateTask,
  create_event: summarizeCreateEvent,
  update_event: summarizeUpdateEvent,
  delete_event: summarizeDeleteEvent,
};

/**
 * Default `summarize`: a readable template for each of DEFAULT_GUARDED_TOOLS, falling back to the tool name
 * plus `JSON.stringify(input)` for any other guarded tool name (so extending `toolNames` never leaves a
 * confirmation message empty, only less pretty).
 */
export function defaultSummarize(toolName: string, input: unknown): string {
  const template = SUMMARY_TEMPLATES[toolName];
  return template ? template(input) : `${toolName}(${JSON.stringify(input)})`;
}

/**
 * Options for withWriteConfirmation.
 */
export interface WriteConfirmationOptions {
  /** Tool names to guard; defaults to DEFAULT_GUARDED_TOOLS. Tools not in this list are passed through as-is. */
  toolNames?: readonly string[];
  /** Confirmation function; defaults to promptConfirm. Tests inject a fake so they never touch stdin. */
  confirm?: ConfirmFn;
  /** Builds the message shown to the user for a guarded call; defaults to defaultSummarize. */
  summarize?: (toolName: string, input: unknown) => string;
}

/**
 * Wraps every guarded tool's `execute` so it always asks for confirmation before running, regardless of how
 * the LLM decided to call it (issue #9: unlike the removed request_confirmation tool, which relied on the
 * LLM remembering to call it first, this makes the confirmation structurally unavoidable). Tools outside
 * `options.toolNames` are returned unchanged.
 *
 * On rejection the original `execute` is never called and `{ confirmed: false }` is returned instead, so a
 * declined write leaves no side effect. On approval the original `execute` runs and its result is returned
 * unchanged, so a caller reading a successful create_task/create_event/etc. result sees the same shape as
 * before this Hook existed.
 */
export function withWriteConfirmation(tools: ToolSet, options: WriteConfirmationOptions = {}): ToolSet {
  const guarded = new Set(options.toolNames ?? DEFAULT_GUARDED_TOOLS);
  const confirm = options.confirm ?? promptConfirm;
  const summarize = options.summarize ?? defaultSummarize;

  const wrapped: ToolSet = {};
  for (const [name, toolDef] of Object.entries(tools)) {
    const originalExecute = toolDef.execute;
    if (!guarded.has(name) || !originalExecute) {
      wrapped[name] = toolDef;
      continue;
    }
    wrapped[name] = {
      ...toolDef,
      execute: async (input: unknown, execOptions) => {
        if (!confirm(summarize(name, input))) {
          return { confirmed: false };
        }
        return await originalExecute(input as never, execOptions);
      },
    };
  }
  return wrapped;
}
