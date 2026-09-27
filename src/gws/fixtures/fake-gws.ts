/**
 * Fake gws binary used by runner.test.ts to exercise GwsProcessRunner without spawning the real CLI.
 * The first positional argument selects a scenario; `--params` (when present) carries scenario-specific
 * configuration, mirroring how buildGwsArgs shapes a real request.
 */
const args = process.argv.slice(2);
const scenario = args[0];
const paramsIndex = args.indexOf("--params");
const params: Record<string, unknown> = paramsIndex !== -1 ? JSON.parse(args[paramsIndex + 1] ?? "{}") : {};

/**
 * Writes stdout/stderr and exits, mirroring how the real gws binary reports results (docs/spikes/gws-cli-0.22.5.md §7).
 */
function printAndExit(stdout: string, exitCode: number, stderr = ""): never {
  if (stdout) process.stdout.write(stdout.endsWith("\n") ? stdout : `${stdout}\n`);
  if (stderr) process.stderr.write(stderr.endsWith("\n") ? stderr : `${stderr}\n`);
  process.exit(exitCode);
}

switch (scenario) {
  case "ok":
    printAndExit(JSON.stringify({ ok: true, args }), 0);
    break;

  case "pretty":
    // Mirrors gws's real default formatting for a non-paginated call (pretty-printed, multi-line JSON),
    // as opposed to --page-all's compact one-line-per-page NDJSON.
    printAndExit(JSON.stringify({ ok: true }, null, 2), 0);
    break;

  case "authfail":
    printAndExit(
      JSON.stringify({ error: { code: 401, message: "Access denied.", reason: "authError" } }),
      2,
      "error[auth]: Access denied.",
    );
    break;

  case "apifail":
    printAndExit(
      JSON.stringify({ error: { code: 404, message: "Not Found", reason: "notFound" } }),
      1,
      "error[api]: Not Found",
    );
    break;

  case "validationfail":
    printAndExit(
      JSON.stringify({ error: { code: 400, message: "Invalid --params JSON", reason: "validationError" } }),
      3,
      "error[validation]: Invalid --params JSON",
    );
    break;

  case "stderr-only-failure":
    // No JSON envelope on stdout at all, e.g. a crash before argument parsing; toGwsError must fall back to stderr.
    printAndExit("", 5, "internal panic: something broke");
    break;

  case "malformed":
    printAndExit("not json", 0);
    break;

  case "pages": {
    // Emits `count` NDJSON pages; `exhausted: false` leaves a nextPageToken on the last page, simulating
    // --page-limit being hit before Google itself ran out of results (docs/spikes/gws-cli-0.22.5.md §5).
    const count = Number(params.count ?? 1);
    const exhausted = params.exhausted !== false;
    const lines: string[] = [];
    for (let i = 0; i < count; i++) {
      const isLast = i === count - 1;
      const page: Record<string, unknown> = { items: [{ id: `item-${i}` }] };
      if (!isLast || !exhausted) page.nextPageToken = `token-${i + 1}`;
      lines.push(JSON.stringify(page));
    }
    printAndExit(lines.join("\n"), 0);
    break;
  }

  case "slow": {
    await Bun.sleep(Number(params.ms ?? 5000));
    printAndExit(JSON.stringify({ ok: true }), 0);
    break;
  }

  default:
    printAndExit(
      JSON.stringify({ error: { code: 400, message: `unknown scenario: ${scenario}`, reason: "validationError" } }),
      3,
    );
}
