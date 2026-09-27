# Spike notes: `bunx @googleworkspace/cli@0.22.5` (gws)

Conducted 2026-09-27. Verified against two real accounts (`normal`/`school` in this plan's naming), after completing
the browser-based OAuth consent (user action) and logging in to `~/.config/satellite/gws/normal/` and
`~/.config/satellite/gws/school/` (each 0700) with `GOOGLE_WORKSPACE_CLI_KEYRING_BACKEND=file`. Every command was run
from `cd "$HOME"` (outside the project), passing `GOOGLE_WORKSPACE_CLI_CLIENT_ID`/`CLIENT_SECRET` from
`~/.config/satellite/gcp-oauth.keys.json` (`installed` key). Real email addresses, calendar ids, and task bodies have
been removed from this document and the fixtures and replaced with fictitious values throughout.

## 1. Startup and `--help`

- `bunx @googleworkspace/cli@0.22.5` has low startup overhead once cached (`--help` runs in roughly 50ms). Calls that
  actually hit the API take about 300-450ms (including the network round trip).
- Subcommand syntax: `gws <service> <resource> [sub-resource] <method> [flags]` (e.g.
  `gws calendar events list --params '{...}'`). `gws schema <service.resource.method> [--resolve-refs]` is also
  available to inspect a method's schema.
- Flags:
  - `--params <JSON>`: URL/query parameters (e.g. `calendarId`, `timeMin`, `sendUpdates`, `tasklist`, etc.).
  - `--json <JSON>`: request body (for POST/PATCH/PUT).
  - `--page-all`: automatic paging, emitting one page per line as NDJSON.
  - `--page-limit <N>` (default 10), `--page-delay <MS>` (default 100).
  - `--output <PATH>`: destination for a binary response (see §8, relevant to delete's response).
  - `--format` (json/table/yaml/csv, default json), `--dry-run`, `--sanitize <TEMPLATE>`.
- Exit codes: `0` success / `1` API error / `2` auth error / `3` validation error / `4` discovery error / `5`
  internal error. This spike only reproduced `0`, `1`, `2`, and `3`. `4` (discovery failure) and `5` (internal
  error) were not verified since no reliable way to trigger them was found (runner's `toGwsError` falls back
  generically for the documented codes it could not reproduce).

## 2. Per-account authentication (file keyring)

- Setting `GOOGLE_WORKSPACE_CLI_CONFIG_DIR=<dir>` and `GOOGLE_WORKSPACE_CLI_KEYRING_BACKEND=file` creates exactly
  three files under `<dir>`: `.encryption_key`, `client_secret.json` (copied in during `auth login`), and
  `credentials.enc`. Nothing is registered in the OS keyring (e.g. GNOME Keyring); the keyring's contents were
  unchanged before and after `gws auth login`.
- The directory was operated with 0700 permissions (since the encryption key and the token live in the same place).

## 3. `oauthClientFile`'s JSON structure

`~/.config/satellite/gcp-oauth.keys.json` (a "Desktop app" OAuth client downloaded from Google Cloud Console) has a
single top-level key, `installed`, structured as follows:

```json
{
  "installed": {
    "client_id": "...",
    "project_id": "...",
    "auth_uri": "https://accounts.google.com/o/oauth2/auth",
    "token_uri": "https://oauth2.googleapis.com/token",
    "auth_provider_x509_cert_url": "https://www.googleapis.com/oauth2/v1/certs",
    "client_secret": "...",
    "redirect_uris": ["..."]
  }
}
```

`google_config.ts`'s `loadOAuthClient` prefers `installed` but also defensively supports the `web` key structure
that Google issues for "Web application" clients (same `client_id`/`client_secret` shape; unverified here, but
documented by Google as structurally identical).

## 4. Event list response shape and multiple calendars

- `gws calendar events list --params '{"calendarId":"primary","timeMin":"...","timeMax":"...","singleEvents":true,"orderBy":"startTime"}'`
  returns the Google Calendar API's raw response envelope as-is:
  `{ "kind": "calendar#events", "etag": "...", "summary": "...", "accessRole": "...", "defaultReminders": [...], "nextPageToken"?: "...", "items": [...] }`.
  Each element of `items[]` is a Calendar API Event resource itself (`id`, `summary`, `description`, `location`,
  `status`, `start: { dateTime, timeZone } | { date }`, `end: { ... }`, etc.), with the same field names as the
  old `@cocal/google-calendar-mcp`'s `StructuredEvent`. The existing `mapper.ts` conversion logic (reading
  `id`/`summary`/`start`/`end`) carries over almost unchanged.
- Fetching the school account's shared calendar (fictitious id `shared-lab@group.calendar.google.com`, standing in
  for the real `swlab`-equivalent calendar) through the **normal** account with the same `calendarId` returns an
  HTTP 404:
  ```json
  { "error": { "code": 404, "message": "Not Found", "reason": "notFound" } }
  ```
  with exit code `1` (API error). This confirms the existing design decision (querying a shared calendar only
  through the account it belongs to, never as a cross product) still applies under gws.
- Fetching the same shared calendar through the **school** account succeeds with a 200.

## 5. NDJSON paging and detecting the page limit

- `--page-all --page-limit N` emits up to N lines, each one page (the Google API's raw response envelope) as a
  single line of JSON. Each line contains the same `items`/`nextPageToken` envelope described above; extracting
  just `items` is the caller's responsibility (the layer above the runner).
- Whether the page limit was hit can be determined by **checking whether the last emitted line still has a
  `nextPageToken`** (confirmed with `--page-limit 3`: exactly 3 lines were emitted, and the 3rd line still had a
  `nextPageToken`). That means more results exist but were silently cut off, so the runner should treat this case
  as an error.
- When every page has been consumed, the last line has no `nextPageToken` (confirmed with the same check on the
  Google Tasks side too).

## 6. Task list response shape and where the "test task" lives

- `gws tasks tasks list --params '{"tasklist":"@default","showCompleted":true,"showHidden":false,"showDeleted":false}'`
  returns the raw Google Tasks API response: `{ "kind": "tasks#tasks", "etag": "...", "nextPageToken"?: "...", "items": [...] }`.
  Each element of `items[]` is `{ id, title, status: "needsAction"|"completed", notes?, due?, completed?, parent? }`.
  There is none of the old `@girmmy/google-tasks-mcp-server`'s own local truncation (`has_more`/
  `truncation_message`); gws is a thin wrapper over the Tasks API, so paging relies solely on Google's own
  `nextPageToken`. This means the existing adapter's "retry the page at half the limit" logic is no longer needed
  at all.
- The query parameter is named `tasklist` (not the old MCP's `tasklist_id`).
- The pre-existing verification task (its real title withheld; fixtures use a fictitious title such as
  `Buy milk`) lived in the **normal** account's `@default` task list.
- Listing task lists (`gws tasks tasklists list`) returned exactly one list per account (each account's own
  default list only).
- **Empty-results check (2026-09-27, for the "missing `items`" defensive-coding question):** a read-only call with
  a `dueMin`/`dueMax` window matching nothing (`1990-01-01T00:00:00Z`..`1990-01-02T00:00:00Z`) was run against both
  accounts' `@default` list, e.g.:
  ```
  GOOGLE_WORKSPACE_CLI_CONFIG_DIR=~/.config/satellite/gws/normal GOOGLE_WORKSPACE_CLI_KEYRING_BACKEND=file \
    bunx @googleworkspace/cli@0.22.5 tasks tasks list \
    --params '{"tasklist":"@default","dueMin":"1990-01-01T00:00:00Z","dueMax":"1990-01-02T00:00:00Z","showCompleted":true,"showHidden":false,"showDeleted":false}'
  ```
  Both accounts returned `{"etag":"...","items":[],"kind":"tasks#tasks"}`, i.e. `items` was present but empty, not
  omitted, in this particular case. However, `gws schema tasks.tasks.list --resolve-refs` shows `items` is not
  marked as a required field of the response schema, so an empty result omitting `items` altogether remains
  possible for other accounts/quota projects/API revisions. The adapter therefore still treats a missing `items`
  key defensively as an empty list rather than an error (see `src/adapters/google-tasks/adapter.ts`'s
  `expectItems`, and its fixture `list-empty-tasks.json`).

## 7. Error JSON shape and exit codes

On error, stdout always contains the following shape (stderr also gets one line, `error[<kind>]: <message>`):

```json
{ "error": { "code": <http-like number>, "message": "...", "reason": "..." } }
```

Observed combinations:

| Exit code | How it was triggered | `error.code` / `reason` |
|---|---|---|
| `1` (API) | `events.list`/`events.get` on a nonexistent/inaccessible calendar | `404` / `notFound` |
| `1` (API) | `events.patch` with a `start`/`end` shape (timed/all-day) that conflicts with the existing value | `400` / `invalid` (message: `"Invalid start time."`) |
| `2` (auth) | Calling the API with no credentials under `GOOGLE_WORKSPACE_CLI_CONFIG_DIR` | `401` / `authError` |
| `3` (validation) | Invalid JSON passed to `--params` / a required parameter (e.g. `calendarId`) missing / a nonexistent subcommand | `400` / `validationError` |
| `4` (discovery) | Not verified | - |
| `5` (internal) | Not verified | - |

Runner's `toGwsError` is based on this table: only for `code === 2` does it append guidance to run
`bun run src/cli/auth.ts <account>`; otherwise it uses `error.message` as-is (falling back to stderr if absent).

## 8. insert -> patch -> delete behavior (an important deviation from the plan)

Performed against the `normal` account's primary calendar; every created event was deleted after verification
(`sendUpdates: none` was passed every time; there were no guests, so no notification email would have been sent
regardless).

1. **insert**: `gws calendar events insert --params '{"calendarId":"primary","sendUpdates":"none"}' --json '{"summary":"...","start":{"dateTime":"..."},"end":{"dateTime":"..."}}'`
   returns the Event resource itself, with no wrapper such as `{"event": ...}`. Exit code `0`.
2. **Attempting a patch to switch timed -> all-day failed** (**the plan's assumption of "explicitly clearing the
   other shape's fields with `null`" does not hold under gws**):
   - Including `"dateTime": null` in `--json` fails, because gws validates the request body locally against its
     own schema, producing a **validation error (exit code 3)**: `Expected type 'string', found null`. Unlike the
     raw Google API, gws does not pass `null` through transparently.
   - Sending just `{"start":{"date":"..."},"end":{"date":"..."}}` via `patch`, without `null`, fails differently:
     Google **merges `start`/`end` as nested objects**, so the old `dateTime`/`timeZone` remain alongside the new
     `date`, producing an invalid object with both `date` and `dateTime` present, which Google rejects with
     `400 Invalid start time.` (**API error, exit code 1**).
   - **Verified workaround**: using `events.update` (PUT, full replace) instead of `events.patch` (PATCH, partial
     update) correctly switches the timed/all-day shape. However, since PUT replaces the entire Event resource,
     the adapter must first call `events.get` and carry over the fields that were not patched (`summary`,
     `description`, `location`, etc.), or they would be lost.
   - Conversely, changes that do not alter the shape (timed vs. all-day) — title only, a time change within the
     same shape, a date change within the same shape — work fine through `events.patch`.
   - -> **Implementation decision**: `updateEvent` only takes the "`events.get` -> merge -> `events.update` (PUT)"
     path when the timed/all-day shape actually needs to change (i.e. the caller's requested start/end shape
     differs from the event's current shape); everything else (title-only changes, or a time/date change that
     keeps the same shape) continues to use `events.patch` as before.
3. **delete**: `gws calendar events delete --params '{"calendarId":"primary","eventId":"...","sendUpdates":"none"}'`
   returns exit code `0`. **The output is not empty**: stdout contains
   `{"bytes":0,"mimeType":"text/html","saved_file":"download.html","status":"success"}`. This is because Google's
   DELETE response has an empty/non-JSON body (effectively 204), which gws treats as a "binary download"; as a
   side effect, a **0-byte `download.html` file is actually created in the current directory**.
   - -> **Impact on the runner**: success should be checked via `status === "success"` (there is no boolean
     `success` field).
   - -> **Impact on the runner (important)**: to avoid leaving this side-effect file in the project directory or
     elsewhere, `Bun.spawn`'s `cwd` must be pinned to a dedicated scratch directory
     (`<configDir()>/gws-cwd/`), not the project root.
   - Running `events.get` on the same event after deletion does not return a physical deletion, but a tombstone
     with `status: "cancelled"` (this does not show up in the default `events.list` call, where `showDeleted` is
     unset/false — the usual Calendar API behavior).

## 9. Effect of the project's `.env` (dotenvy)

- satellite's `.env` (`GEMINI_API_KEY`, `GOOGLE_OAUTH_CREDENTIALS`) has no variable names that collide with
  `GOOGLE_WORKSPACE_CLI_*`, so running `bunx @googleworkspace/cli@0.22.5` with the project root as cwd produced no
  observable difference in authentication or API call results (the same `tasks tasklists list` call was run from
  both the repo root and `$HOME`, with identical results).
- That said, as noted in §8, `delete` writes a side-effect file to the current directory, so the runner still
  pins its cwd to a dedicated directory outside the project (this is not caused by anything in `.env`'s content,
  but by the cwd itself).

## 10. Fixtures

Sanitized fixtures were placed as follows (real email addresses, real event/task titles, and real ids have all
been replaced with fictitious values):

- `src/adapters/google-calendar/fixtures/list-events.json`: mimics one page (the Calendar API envelope containing
  an `items` array) of `gws calendar events list --page-all`.
- `src/adapters/google-tasks/fixtures/list-tasks.json`: mimics one page (the Tasks API envelope containing an
  `items` array) of `gws tasks tasks list --page-all`.
- `src/adapters/google-tasks/fixtures/list-empty-tasks.json`: mimics the empty-results envelope observed in §6,
  used to test that a page without an `items` key is treated as zero tasks.

## 11. `tasks.tasks.insert` request shape (issue #7, **not yet verified against a real account**)

**This section is not based on a live gws invocation.** `gws` was not installed in the environment this was
implemented in (`which gws` failed), so `gws schema tasks.tasks.insert --resolve-refs` could not be run and no
live `insert` call (with or without `parent`) could be exercised. The shape below is instead inferred from the
Google Tasks API v1 reference (`tasks.insert`: https://developers.google.com/tasks/reference/rest/v1/tasks/insert)
together with the conventions already confirmed elsewhere in this document (§1's `--params`/`--json` split, and
§6's observation that gws is "a thin wrapper over the Tasks API" with no extra behavior of its own). **Before
relying on this in production, re-run `gws schema tasks.tasks.insert --resolve-refs` and a real `insert` call
(with and without `parent`) against a live account, and correct this section if it disagrees.**

- Invocation shape: `gws tasks tasks insert --params '{...}' --json '{...}'`, mirroring `calendar.events.insert`'s
  `--params`/`--json` split (§8) rather than `tasks.tasks.list`'s all-`--params` shape, since `insert` is a
  write with both URL parameters and a request body.
- `--params` (query parameters):
  - `tasklist` (required): the task list id to insert into, same as `tasks.tasks.list`'s `tasklist` (§6).
  - `parent` (optional): id of an existing task in the same list. Per the API reference, this designates the
    new task as the last child of that parent, creating a subtask. **This is a query parameter of the `insert`
    method itself, not a field of the Task resource body** — the Task resource's own `parent` field (already
    modeled in `GoogleTask.parent`, populated by `tasks.tasks.list`, §6) is read-only output, only ever set as a
    side effect of this query parameter (or of `tasks.move`). The adapter (`GoogleTasksAdapter.createTask`)
    reflects this by attaching `parent` to the request's `params`, never to its `body`.
  - `previous` (optional, not exposed by this issue's `NewTask`/`create_task`): id of the sibling task this one
    should be inserted after. Left unused for now, since issue #7 has no requirement to control subtask
    ordering; noted here so a future change does not need to re-derive this from the API reference.
- `--json` (request body, a partial Task resource): `title` (required), `notes` (optional), `due` (optional,
  RFC 3339 UTC-midnight timestamp, e.g. `"2026-10-01T00:00:00.000Z"` — the same format `toDueTimestamp` already
  produces for `dueMin`/`dueMax`, and the same format `tasks.tasks.list` returns in `due`, §6). `status` is
  omitted, since Google defaults a newly inserted task to `"needsAction"`.
- Expected response: per the API reference and by analogy with `calendar.events.insert` returning the Event
  resource directly with no wrapper (§8), `tasks.tasks.insert` is expected to return the created Task resource
  itself (`{ id, title, status, notes?, due?, parent?, ... }`), i.e. the same shape `tasks.tasks.list` returns
  per item (§6). `GoogleTasksAdapter.createTask` reuses `mapper.ts`'s existing `toTask` to parse it, unverified
  against a real response.
