import { accountConfigDir, loadGoogleConfig, loadOAuthClient } from "../config/google_config";
import { gwsEnv } from "../gws/runner";

/**
 * Authenticates one configured account with gws, so both calendar and tasks work from a single login
 * (design requirement, issue #5: "1 アカウントにつき 1 回の認証").
 * Usage: bun run src/cli/auth.ts <account>
 *
 * Uses the exact same environment (gwsEnv) as GwsProcessRunner, so a successful login here is guaranteed to
 * be usable by the runtime; stdio is inherited so the browser-based OAuth flow's prompts/URL reach the user.
 */
async function main() {
  const account = process.argv[2];
  if (!account) {
    throw new Error("アカウント名を引数として指定してください（例: bun run src/cli/auth.ts normal）");
  }

  const config = await loadGoogleConfig();
  if (!config.accounts.some((a) => a.name === account)) {
    const known = config.accounts.map((a) => a.name).join(", ");
    throw new Error(`google_config.json に "${account}" という account は定義されていません（設定済み: ${known}）`);
  }

  const oauthClient = await loadOAuthClient(config.oauthClientFile);
  const dir = await accountConfigDir(account);
  const env = gwsEnv({ configDir: dir, clientId: oauthClient.clientId, clientSecret: oauthClient.clientSecret });

  const proc = Bun.spawn([...config.gwsCommand, "auth", "login", "-s", "calendar,tasks"], {
    env: { ...process.env, ...env },
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(`gws auth login がアカウント "${account}" に対して失敗しました（終了コード: ${exitCode}）`);
  }
  console.log(`アカウント "${account}" の認証が完了しました（${dir}）`);
}

main().catch((err) => {
  console.error("エラーが発生しました:", err);
  process.exit(1);
});
