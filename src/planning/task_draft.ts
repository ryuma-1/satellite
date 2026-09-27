/**
 * A task's required data as gathered so far, before it is created (issue #9's task-creation Skill). Fields
 * are strings/numbers straight from the LLM's own draft, rather than typed Task/NewTask fields, since a
 * value can be genuinely missing (rather than merely optional) at this stage.
 */
export interface TaskDraftInput {
  /** Task title, once known. */
  title?: string;
  /** Estimated hours the task will take, once known. */
  estimatedHours?: number;
  /** Deadline (ISO 8601 date or date-time), once known. */
  deadline?: string;
}

/**
 * The three fields checkTaskDraft can report missing, named to match TaskDraftInput's own keys so callers
 * (and the LLM reading a tool result) never need a separate mapping between the two.
 */
export type RequiredTaskDraftField = "title" | "estimatedHours" | "deadline";

/**
 * Result of checkTaskDraft.
 */
export interface TaskDraftCheck {
  /** True once every required field is present, i.e. `missing` is empty. */
  complete: boolean;
  /** Required fields still missing, in TaskDraftInput's own field order. */
  missing: RequiredTaskDraftField[];
}

/**
 * Checks whether a task draft has every field task-creation's Skill requires before calling create_task
 * (title, estimatedHours, deadline; see skills/task-creation/SKILL.md), so the LLM can keep asking the user
 * (via ask_user) until it does, instead of guessing at a missing value or skipping straight to create_task.
 * An empty/blank title, or a non-positive estimatedHours, counts as missing, not merely "present but invalid":
 * either would make the resulting task useless, so it should be re-asked exactly like an absent value.
 */
export function checkTaskDraft(draft: TaskDraftInput): TaskDraftCheck {
  const missing: RequiredTaskDraftField[] = [];
  if (draft.title === undefined || draft.title.trim().length === 0) missing.push("title");
  if (draft.estimatedHours === undefined || draft.estimatedHours <= 0) missing.push("estimatedHours");
  if (draft.deadline === undefined || draft.deadline.trim().length === 0) missing.push("deadline");
  return { complete: missing.length === 0, missing };
}
