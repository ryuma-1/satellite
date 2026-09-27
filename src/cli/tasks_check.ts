import { GoogleTasksAdapter } from "../adapters/google-tasks/adapter";
import { loadGoogleConfig, loadOAuthClient } from "../config/google_config";
import { GwsProcessRunner } from "../gws/runner";

/**
 * Manual smoke test for the tasks gws integration: lists every task across every configured account/list.
 * Usage: bun run src/cli/tasks_check.ts
 */
async function main() {
  const config = await loadGoogleConfig();
  const oauthClient = await loadOAuthClient(config.oauthClientFile);
  const runner = new GwsProcessRunner({ gwsCommand: config.gwsCommand, oauthClient });
  const tasks = new GoogleTasksAdapter(runner, { accounts: config.accounts });

  const results = await tasks.listTasks();
  if (results.length === 0) {
    console.log("タスクはありません");
    return;
  }
  for (const t of results) {
    const account = t.account ? `[${t.account}] ` : "";
    const taskListId = t.taskListId ? `(${t.taskListId}) ` : "";
    const due = t.due ? ` (期限: ${t.due.toLocaleDateString()})` : "";
    const status = t.completed ? "[完了] " : "";
    console.log(`${status}${account}${taskListId}${t.title}${due}`);
  }
}

main().catch((err) => {
  console.error("エラーが発生しました:", err);
  process.exit(1);
});
