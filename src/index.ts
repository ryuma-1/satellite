import { DEFAULT_CALENDAR_ID, GoogleCalendarAdapter } from "./adapters/google-calendar/adapter";
import { DEFAULT_TASK_LIST_ID, GoogleTasksAdapter } from "./adapters/google-tasks/adapter";
import { loadGoogleConfig, loadOAuthClient } from "./config/google_config";
import { loadScheduleConfig } from "./config/schedule_config";
import { GwsProcessRunner } from "./gws/runner";
import { createModel } from "./llm/model";
import { runAgent } from "./planning/agent";
import { createCalendarTools, resolveCalendarIds } from "./planning/calendar_tools";
import { createDialogueTools } from "./planning/dialogue_tools";
import { createSkillTools } from "./planning/skill_tools";
import { buildSystemPrompt, resolveAccountCalendars } from "./planning/system_prompt";
import { createTaskTools, resolveAccountTaskLists } from "./planning/task_tools";
import { discoverSkills, loadSkillBody } from "./skills/registry";

/**
 * Upper bound on model steps for one runAgent call. Raised above runAgent's own default of 10, and again
 * above issue #7's 20: creating a task now typically spans load_skill, a check_task_draft/ask_user loop
 * (repeated once per missing field), list_tasks (duplicate check), one find_free_slot call and one
 * (Hook-confirmed) create_task call per subtask, before the final text answer (implementation plan, issue #9,
 * "MAX_AGENT_STEPS の再見積もり").
 */
const MAX_AGENT_STEPS = 30;

/**
 * Answers one natural-language request, letting the LLM call calendar and task tools as needed.
 * Usage: bun run src/index.ts <request>
 *
 * Unlike the old MCP-based design, there is no persistent server connection to open/close here: gws is
 * spawned fresh for each tool call via GwsProcessRunner (design_doc §1.4), so main() only needs to load
 * config and run the agent loop.
 */
async function main() {
  const question = process.argv.slice(2).join(" ");
  if (!question) {
    throw new Error("質問文を引数として指定してください（例: bun run src/index.ts 質問内容）");
  }

  // Validate local settings before spawning any gws process, so misconfiguration fails fast.
  const model = createModel();
  const config = await loadGoogleConfig();
  const oauthClient = await loadOAuthClient(config.oauthClientFile);
  const schedule = await loadScheduleConfig();
  const runner = new GwsProcessRunner({ gwsCommand: config.gwsCommand, oauthClient });

  const accountNames = config.accounts.map((a) => a.name);
  // Union across accounts so the LLM is offered every calendar id it might see in list_events, regardless
  // of which account owns it.
  const calendarIds = resolveCalendarIds(config.accounts, DEFAULT_CALENDAR_ID);
  const accountCalendars = resolveAccountCalendars(config.accounts, DEFAULT_CALENDAR_ID);
  const accountTaskLists = resolveAccountTaskLists(config.accounts, DEFAULT_TASK_LIST_ID);

  const calendar = new GoogleCalendarAdapter(runner, { accounts: config.accounts });
  const tasks = new GoogleTasksAdapter(runner, { accounts: config.accounts });
  const skills = await discoverSkills();

  const tools = {
    ...createCalendarTools(calendar, accountNames, calendarIds),
    ...createTaskTools(tasks, accountTaskLists, calendar, { workingHours: schedule.workingHours }),
    ...createSkillTools(skills, (name) => loadSkillBody(name)),
    ...createDialogueTools(),
  };

  const answer = runAgent({
    model,
    tools,
    instructions: buildSystemPrompt({
      now: new Date(),
      accounts: accountNames,
      accountCalendars,
      accountTaskLists,
      skills,
    }),
    prompt: question,
    maxSteps: MAX_AGENT_STEPS,
    onToolError: (toolName, error) => {
      console.error(`[tool ${toolName}] ${error instanceof Error ? error.message : String(error)}`);
    },
  });
  for await (const chunk of answer) {
    process.stdout.write(chunk);
  }
  process.stdout.write("\n");
}

main().catch((err) => {
  console.error("エラーが発生しました:", err);
  process.exit(1);
});
