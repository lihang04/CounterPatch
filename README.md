# CounterPatch

**Your coding agent says it's done. CounterPatch makes it prove it.**

CounterPatch is an independent verifier for AI-generated code changes. It records the working tree before a coding task starts, then runs the same behavioural probes against the app as it was (control) and as it is now (candidate), and reports concrete counterexamples: things that worked before the change and do not work after it, with UI, network and database evidence.

It is scoped to one stack: **Next.js + TypeScript + SQLite + Playwright**.

## Status

The execution foundation works end to end. An optional model client generates probe JSON using OpenRouter or a compatible endpoint such as Nebius Token Factory; verification runs those probes locally.

| Piece | State |
| --- | --- |
| Pre-task working-tree snapshot (including uncommitted and untracked files) | Done |
| Control and candidate environments built from snapshots, started on separate ports and databases | Done |
| Probes executed through a real browser, collecting UI, network and database evidence | Done |
| Differential observations plus requirement decisions when a task contract is supplied | Done |
| Versioned task contracts, requirement-linked probes and explicit coverage gaps | Done |
| Verification bundles with retained snapshot references and input hashes | Done |
| Replay saved snapshots, contracts and probes in fresh environments | Done |
| Demo shop with deterministic fixtures and a manifest | Done |
| Session hooks: prompts captured and baseline recorded automatically, verification run when the agent stops | Done for Claude Code |
| Model-generated probes (OpenRouter / compatible chat-completions endpoint) | Implemented; validated locally, provider integration tested with a mock endpoint |
| Model contract drafts from explicit requests or captured prompts, with supporting quotes and questions | Implemented; provider integration tested with a mock endpoint |
| Next.js structure analysis (routes, proxy matchers, server actions, `fetch` relationships) | Not started |
| Repair loop back into the coding agent | Not started |
| Isolated execution on Nebius | Not started; environments run locally |

Probes can be hand-written or generated JSON. Without a contract, verification reports differential observations. With `--contract`, linked requirements determine whether those observations fulfill the task, show a regression, or leave the result inconclusive.

## Quick start

Requires Node 22 or newer, git, and macOS or Linux.

```sh
npm install
npm install --prefix demo-app
npx playwright install chromium
```

Run the checks:

```sh
npm test        # unit tests: snapshots, evidence paths, probe validation, hook state
npm run e2e     # full pipeline and session hooks against a deliberately buggy change (about 1 min)
```

`npm run e2e` copies the demo shop into a temporary repository, records a baseline, applies [test/fixtures/coupons-buggy.patch](test/fixtures/coupons-buggy.patch), and verifies it. That patch adds percentage coupons with two bugs an agent could plausibly ship: a `proxy.ts` matcher that sends guests at `/checkout` to `/login`, and a field-name mismatch that shows a discounted total while charging the full one.

## Using it on a repository

```sh
# 1. Before the coding task starts
npx counterpatch snapshot

# 2. The coding agent edits the app

# 3. After it says it is finished
npx counterpatch verify --app demo-app --probes probes/shop
```

| Command | What it does |
| --- | --- |
| `snapshot` | Records the current working tree as the baseline. |
| `status` | Shows the baseline and the files changed since. |
| `check-model` | Tests the API key and model with a small fixed request; reports connectivity and JSON-output compliance separately. |
| `draft-contract` | Drafts requirements from an explicit request or the open task's captured prompts, with supporting quotes and questions for review. |
| `generate` | Sends the request and app context to a configured model, validates the returned probes, and saves a new generation directory. |
| `verify` | Builds and runs control and candidate, runs the probes, prints the report. `--json` prints the full evidence; `--open` opens the report page in the browser. |
| `replay` | Reruns the snapshots and inputs in `--bundle <bundle.json>` and creates a new report. |
| `clean` | Deletes cached environments and past runs. |

`verify` exits with 0 when checks passed (or the app is unchanged without a contract), 1 when a counterexample, candidate-only failure or unmet task requirement was found, 2 when an environment failed to run or input was invalid, and 3 when verification is inconclusive. With a contract, uncovered requirements and unverified preservation prevent a successful result; any established requirement failure takes precedence and exits 1.

## Verify the task's intent

Write a task contract before making the change. Requirements have stable IDs and two kinds: `change` describes the desired new behavior; `preserve` describes behavior that must keep working. Exclusions document what this task does not check. They do not suppress failing probes.

You can draft the contract with the configured model provider:

```sh
npm run counterpatch -- draft-contract --env-file .env --prompt "Add percentage coupons. Keep guest checkout available."

# Or explicitly select the open task's captured prompt history:
npm run counterpatch -- draft-contract --env-file .env --from-task
```

Drafting sends only the selected request text to the provider. It works in a Git repository without an app manifest or baseline. `--from-task` requires an open task recorded by the prompt hook and sends its prompts in order, including corrections. Every requirement must have exact supporting quotes linked to those prompts; invented quotes, missing links and duplicate IDs are rejected. Quoted support establishes traceability, so review whether the proposed requirement accurately reflects the request.

The command creates a fresh directory under `.git/counterpatch/contract-drafts/` (or `--out <new-directory>`) containing `request.json`, `draft.json`, `metadata.json`, and `contract.json` when a contract could be drafted. Files are readable by their owner only. The request file preserves the selected text locally; metadata records hashes, model usage, task identity and revision. Task/session identity, repository source, and environment files are not sent as drafting context. Keys configure the request and are not saved in draft metadata.

The CLI prints each requirement and its supporting quotes. Review and edit `contract.json`, resolve any questions in `draft.json`, then explicitly select that file with `generate --contract`. The command prints the next generation command when the draft has no unresolved questions. Drafts are never automatically activated by hooks or verification. Drafting exits 0 for a draft ready for review, 3 for unresolved questions or a task that changed while the model was drafting, and 2 for invalid input or provider/output failure. If a follow-up arrives during drafting, the saved draft is marked stale; rerun against the updated request. A request too ambiguous to produce requirements can return questions with no contract file.

`--prompt` and `--from-task` are mutually exclusive. Inputs above 100 prompts or 50,000 serialized characters fail before the model call rather than dropping part of the task. Each invocation sends one model request without automatic retries and may use provider credits.

```json
{
  "schemaVersion": 1,
  "title": "Require login at checkout",
  "requirements": [
    { "id": "guest-access", "kind": "change", "description": "Guests visiting checkout are redirected to login." },
    { "id": "signed-in-orders", "kind": "preserve", "description": "Signed-in customers can still place orders." }
  ],
  "exclusions": ["External payment processing"]
}
```

Every probe used with a contract must include a `requirementId`. For `change`, assert the desired **after** behavior; it may legitimately fail on the baseline. For `preserve`, the probe must run on both snapshots. Missing or unknown IDs and candidate-only preservation probes are rejected. Multiple probes may cover one requirement; every requirement needs usable evidence. Review probe assertions against the requirement text: a valid ID establishes traceability, not semantic correctness.

```sh
# Use your own contract and linked probes; paths are relative to the shell.
npm run counterpatch -- snapshot --repo /path/to/app
# Make the requested code change, then:
npm run counterpatch -- verify --repo /path/to/app --contract task.json --probes task-probes --open

# Or generate linked probes using the configured model provider:
npm run counterpatch -- generate --repo /path/to/app --contract task.json
```

Generation saves a copy of the contract alongside its probes and prints a verification command using that copy. Its metadata includes the contract hash and uncovered requirement IDs. Generation itself does not execute the probes or establish that the task is complete. `hook stop` also accepts `--contract`; hook paths resolve relative to the repository.

| Requirement | Evidence | Decision |
| --- | --- | --- |
| change | Candidate passes its linked probes | Fulfilled by those probes |
| change | Candidate fails a linked probe | Unfulfilled; inspect the probe and evidence |
| preserve | Both snapshots pass | Preserved by those probes |
| preserve | Baseline passes, candidate fails | Regression |
| preserve | Baseline fails | Inconclusive: existing defect or invalid probe |
| either | No linked probes, missing execution, or failed database observation | Inconclusive |

An unchanged app still runs verification when a contract is supplied: unchanged code may leave the request unimplemented. Contracts do not automatically distinguish flaky runs or prove the assertions match the prose. Decisions describe the evidence from this run.

In `report.json`, `assessment` contains the contract, requirement decisions, supporting probe IDs and observed pass/fail patterns. It determines the exit code when present. `results[].verdict` retains the older differential labels for compatibility; a baseline failure there does not override a fulfilled change requirement.

The examples in [examples/require-login/](examples/require-login/) and [examples/preserve-guest/](examples/preserve-guest/) evaluate the same checkout redirect under opposite requirements. Run either against an app whose baseline permits guests and whose candidate redirects them to `/login`:

```sh
npm run counterpatch -- verify --repo /path/to/shop --contract examples/require-login/contract.json --probes examples/require-login/probes --open
npm run counterpatch -- verify --repo /path/to/shop --contract examples/preserve-guest/contract.json --probes examples/preserve-guest/probes --open
```

The first fulfills the requested access change; the second reports a regression. These examples check guest access only. The end-to-end suite also checks actual guest order completion and missing coverage.

Each executed run saves `bundle.json` before app commands start: the contract, probes, app manifests, baseline and candidate tree IDs, execution limits, Node/platform information, verifier source and dependency-lock hashes, and a SHA-256 digest of the bundle payload. Git refs under `refs/counterpatch/runs/` retain the snapshots after the baseline moves.

```sh
npm run counterpatch -- replay --bundle /path/to/run/bundle.json --open

# If the repository has moved, locate its retained Git objects explicitly:
npm run counterpatch -- replay --bundle /path/to/run/bundle.json --repo /new/path/to/repo --json
```

Replay uses the saved contract, probes, app path and Git tree IDs even if the current app has changed or been deleted. It preserves the checkout, index, current baseline and hook task state. It checks the bundle's schema and digest, requirement links, Git object types, app subtree relationships and manifests against the retained snapshots before executing app commands. Probes and contracts cannot be overridden during replay. The recorded browser step and network settling limits are restored.

Every replay installs and builds in fresh directories under the new run's `environment-cache/` and uses fresh runtime databases. It writes a new bundle and report linked to the source bundle. JSON includes `replay.sourceBundle` and any `replay.executionDrift`; the terminal and HTML reports disclose differences in Node, platform, architecture, verifier code and dependency-lock identity. Replay uses verification's exit codes, including 1 when a retained regression is reproduced.

The bundle remains a local audit record. It requires the retained source objects in a Git repository and executes app commands on the host. Inherited environment values are not recorded; package downloads, browser installations and external services can change. Fresh builds and recorded inputs make replay useful for reproducing findings, without guaranteeing identical execution or host isolation. The SHA-256 digest detects edits but does not authenticate a bundle's author. `clean` removes run directories but deliberately leaves Git snapshot refs intact; keep a copy of `bundle.json` to replay after cleaning.

`npm run eval` runs the labeled decision cases in [test/fixtures/contract-cases.json](test/fixtures/contract-cases.json) and reports detection, false alarms and inconclusive results. This small deterministic corpus exercises decision rules; it does not estimate model quality or production accuracy. `npm run e2e` exercises the checkout example in a real browser.

An inconclusive run still saves its evidence and report page, and `--open` opens it. The stop hook reports the inconclusive result and keeps the task and its original baseline open. Repair or add probes, then verify again.

### Generate probes with OpenRouter

Run these commands from the repository root. Set your key in the shell and choose an exact model ID from your provider's model catalog; no model is selected automatically. Environment files are not loaded automatically.

After filling in `.env`, check your settings before generating probes:

```sh
npm run counterpatch -- check-model --env-file .env
```

This sends only a fixed test message, with at most 2048 output tokens (or your configured lower limit). It works without a Git repository or baseline and does not send source code, manifests, or task prompts. It reports whether the provider accepted the key and returned a model response, plus a separate JSON-output check. Exit 0 means the model responded; exit 2 indicates a configuration or request failure. A JSON warning means access works but generation may still fail. `--json` provides machine-readable results. This is one live model request and may use provider credits.

`check-model`, `draft-contract`, and `generate` accept `--env-file .env`; file values override shell settings and `--model` / `--base-url` override both. The file is parsed as configuration, never executed as shell code.

Alternatively, copy [`.env.example`](.env.example) to `.env`, fill in `OPENROUTER_API_KEY` and `COUNTERPATCH_MODEL`, and load it into your current shell before running the commands below. Local `.env` files are gitignored.

```sh
cp .env.example .env
# Edit .env with your key and model ID, then:
set -a
. ./.env
set +a
```

If you loaded `.env`, skip the two `export` lines below.

```sh
export OPENROUTER_API_KEY='your-api-key'
export COUNTERPATCH_MODEL='your-provider-model-id'

# Record before the coding task, then make the app change.
npm run counterpatch -- snapshot

# After the change, generate up to five probes. --probes supplies optional examples.
npm run counterpatch -- generate --app demo-app \
  --prompt "Add percentage coupons. Guest checkout must keep working, and displayed totals must equal charged totals." \
  --probes probes/shop --count 5 --out /tmp/counterpatch-generation

# Execute the generated probes and open their evidence report.
npm run counterpatch -- verify --app demo-app \
  --probes /tmp/counterpatch-generation/probes --open
```

Choose a fresh `--out` directory for each generation. Existing directories are never overwritten. Without `--out`, generations go inside the repository's Git state directory at `counterpatch/generations/<id>/`. Each generation contains `probes/*.json` and a separate `generation.json` recording the request, snapshot IDs, requested and returned model, response ID, duration, and token usage when provided. The CLI prints the next verification command. `--json` prints this metadata and the probes directory as JSON.

The generator sends the explicit request, baseline and candidate manifests, selected JavaScript/TypeScript source, root app `package.json`, the diff for those files, and any supplied example probes. Source comes from Git snapshots, including untracked files. It excludes untracked gitignored files, `.env` files, other file types, and source under dependency/build/test directories. The diff is built from exactly the selected files on each side, including when a file becomes a directory or vice versa. Selected source or manifests can still contain sensitive values. Each side is limited to 100 source files, and combined context to 200,000 characters; exceeding a limit fails before the model request instead of silently dropping context.

Generated JSON must pass the existing probe schema, have unique IDs, start with a local navigation, and contain only supported steps and valid expectations. The parser accepts a single JSON probe object surrounded by prose or Markdown fences and can strip completed leading `<think>` sections. It rejects incomplete or ambiguous answers and does not repair JSON syntax. One invalid probe rejects the entire batch and leaves no runnable output directory; the rejected response and model metadata are saved privately next to it as `<output>.failed-<id>.json`, with the path printed in the error. That file can contain generated app details; it excludes request headers and API credentials. Schema validation does not prove that a probe works; run `verify` to establish that. Hooks do not call the model automatically. The client makes one request without automatic retries.

To switch to Nebius Token Factory:

```sh
export COUNTERPATCH_BASE_URL='https://api.tokenfactory.nebius.com/v1'
export NEBIUS_API_KEY='your-nebius-key'
export COUNTERPATCH_MODEL='your-nebius-model-id'
```

`--model` and `--base-url` override the corresponding environment settings. `COUNTERPATCH_API_KEY` overrides provider-specific keys and is required for other compatible endpoints. `COUNTERPATCH_MODEL_TIMEOUT_MS` defaults to 120000 and `COUNTERPATCH_MAX_TOKENS` defaults to 8192. Increase the token budget or lower `--count` if output is truncated. API URLs require HTTPS, with HTTP allowed for localhost testing. The client uses standard non-streaming chat completions with local JSON validation; provider-specific structured-output features are not required. See the [OpenRouter API reference](https://openrouter.ai/docs/api/reference/overview) and [Nebius API reference](https://api.tokenfactory.nebius.com/docs).

A report looks like this (shortened):

```text
COUNTERPATCH

Probes run:              7
Valid baseline probes:   5
Unverified on baseline:  1
Candidate-only probes:   1

✗ Guest checkout completes an order  [guest-checkout]
  BEFORE  passed — ended on /order/1; network: POST /api/cart → 200, POST /api/orders → 201; db: orders +1, order_items +1
  AFTER   failed — ended on /login; network: POST /api/cart → 200; db: no new rows
          step 5 (fill checkout-email): no usable "checkout-email" element within 2s on /login
  Observed differences (control → candidate):
    ui.url: "/order/1" → "/login"

? Coupon total shown at checkout is the total that is charged  [coupon-total-consistency]
  AFTER   failed — ended on /order/1; …
          Stored order total equals the total displayed at checkout — db.orders.added[0].total_cents is 8000, ui.captures.checkoutTotal is 7200
```

### The report page

Every completed or inconclusive run also writes `report.html` next to its evidence, and the terminal report ends with its path. It is one self-contained file with the screenshots embedded, so it can be opened directly or sent to someone.

Without a contract, the page leads with what was found, then shows each counterexample with the app before and after the change side by side and a table of what differed on the page, on the network and in the database. Counterexamples that end on the same unexpected page are grouped as one symptom, so one redirect seen by six probes reads as one finding. Passing probes and probes that could not establish preservation appear below. With a contract, the page leads with requirement decisions and coverage gaps, with each linked probe's evidence underneath.

Grouping is by symptom, not by cause: it says the probes ended in the same place, not that one defect is behind all of them.

## Running it from the coding-agent session

Two hooks remove the manual steps, so the agent being checked has no say in when or whether verification runs.

| Hook | Claude Code event | What it does |
| --- | --- | --- |
| `counterpatch hook prompt` | `UserPromptSubmit` | Logs the user's prompt. On the first prompt of a task, records the baseline. |
| `counterpatch hook stop` | `Stop` | Runs `verify` for the open task and shows the report to the user. |

To switch them on, merge [examples/claude-code-hooks.json](examples/claude-code-hooks.json) into `.claude/settings.local.json` (your machine only) or `.claude/settings.json` (everyone who clones the repository). They are not enabled in this repository.

A task starts at the first prompt of a session and ends after a conclusive verification with no counterexamples or candidate-only failures. Inconclusive runs keep the task open. Until then, follow-up prompts are judged against the same baseline, so "fix it" after a counterexample is still compared with the tree from before the original request. `counterpatch status` shows the open task. [What is stored, and where](#what-is-stored-and-where) lists what the hooks keep.

Both hooks stay out of the agent's way:

- The prompt hook prints nothing, because Claude Code adds a prompt hook's output to the agent's context.
- The stop hook reports to the user only. It does not send counterexamples back to the agent; that is the repair loop, which comes later.
- Neither hook ever exits with code 2, which Claude Code treats as "block". Failures are shown to the user as a message instead.

## What is stored, and where

Verification artifacts stay on the machine. The optional `generate` command sends its explicit request and the app context described above to the configured model provider. `draft-contract` sends the explicitly selected request or captured task prompts. Keys are read from model configuration and are not written to generation or draft metadata. Running `verify` or the hooks does not make model calls; app install/build/runtime commands and the browser may use the network.

**In the repository's git directory.** Nothing here is part of the working tree, so none of it can end up in a snapshot or a commit.

| What | Written by | Contents | Kept until |
| --- | --- | --- | --- |
| `.git/counterpatch/prompts.jsonl` | prompt hook | Every prompt submitted in a session: full text, timestamp, session id. Created readable by the owner only. | Deleted by hand |
| `.git/counterpatch/task.json` | prompt hook | Session id, start time and baseline commit of the open task | A conclusive verification finds no counterexample or candidate-only failure |
| `.git/counterpatch/generations/<id>/` | `generate` without `--out` | Generated probes and generation metadata | Deleted by hand |
| `.git/counterpatch/contract-drafts/<id>/` | `draft-contract` without `--out` | Selected prompts, draft requirements, quotes, questions and metadata | Deleted by hand |
| `refs/counterpatch/baseline` | `snapshot`, prompt hook | A copy of every file in the working tree that is not gitignored, as git objects | The next baseline replaces it |
| Unreferenced git objects | `verify`, `status`, stop hook | A snapshot of the current working tree, taken to compare with the baseline | Git's own garbage collection |

**In the CounterPatch home directory.** This is `counterpatch/` inside the system temp directory, or the directory named by `COUNTERPATCH_HOME`.

| What | Written by | Contents | Kept until |
| --- | --- | --- | --- |
| `envs/<tree id>/` | `verify`, stop hook | A full copy of the app at one snapshot, with its installed dependencies and build output, plus the install and build log | `counterpatch clean`, or the system clearing its temp directory |
| `runs/<run id>/` | `verify`, stop hook | Both sides' SQLite databases and server logs, one screenshot per probe per side, `report.json` and `report.html` | `counterpatch clean`, or the system clearing its temp directory |

`report.json` holds the evidence in full, and `report.html` shows the same evidence with the screenshots embedded: the page paths reached, captured on-screen values, the request and response bodies of recorded API calls, and the rows returned by the manifest's database queries.

### Where each log is

`<home>` is the CounterPatch home directory described above. `<tree id>` is the git tree hash of the app directory in one snapshot. `<run id>` is the run's start time plus a random suffix, for example `20261002T165940-453478`.

| Log | Exact path | What goes in it |
| --- | --- | --- |
| Prompt log | `.git/counterpatch/prompts.jsonl` | One JSON line per submitted prompt: time, session id, full text. Appended to; never rotated or trimmed. |
| Task state | `.git/counterpatch/task.json` | The open task: session id, start time, baseline commit. Not a history; it is replaced or deleted as the task changes. |
| Preparation log | `<home>/envs/<tree id>.prepare.log` | Output of the app's install, build-time database reset and build commands for that snapshot, each preceded by a `$ command` line. Rewritten when the environment is prepared again; untouched when the environment is reused from the cache. |
| Control server log | `<home>/runs/<run id>/control.server.log` | Output of the database-reset command before each probe, then everything the pre-task app's server printed. |
| Candidate server log | `<home>/runs/<run id>/candidate.server.log` | The same, for the app as it is now. |
| Evidence | `<home>/runs/<run id>/report.json` | Every probe's verdict, steps that failed, expectations, and the full UI, network and database evidence from both sides. |
| Report page | `<home>/runs/<run id>/report.html` | The same evidence as a page, with screenshots embedded. |
| Screenshots | `<home>/runs/<run id>/<probe id>.control.png` and `<probe id>.candidate.png` | The page at the end of the probe on each side. |

To find these on your machine:

```sh
node -p "require('os').tmpdir() + '/counterpatch'"                        # <home>, unless COUNTERPATCH_HOME is set
ls -t "$(node -p "require('os').tmpdir()")/counterpatch/runs" | head -1   # the most recent <run id>
git rev-parse --git-dir                                                   # the git directory, if it is not ./.git
```

The terminal report also prints the run directory and the report page path at the end, and when an environment fails to install, build or start it prints the path of the log that shows why.

What goes to the terminal and is not written to any file:

- `verify` prints its progress lines to standard error and the text report to standard output. Redirect them to keep a copy, for example `npx counterpatch verify ... > report.txt`.
- `snapshot`, `status` and `clean` print their result to standard output only.
- Error messages go to standard error.

What the hooks do with their output:

- The prompt hook prints nothing. Its only trace is the new line in `prompts.jsonl` and, on the first prompt of a task, `task.json` and the baseline.
- The stop hook sends the text report to the user as a message in the Claude Code session. CounterPatch does not save that text; the same run's `report.json` and `report.html` are saved as for `verify`. Progress lines are not printed in hook mode.
- A hook failure is sent to the user the same way and is not written to a file.

What is not logged anywhere:

- There is no history of CounterPatch's own runs beyond the `runs/` directories: no list of past verdicts and no record of when hooks fired.
- The browser's console output and requests outside the manifest's recorded network paths are not captured.

**Not stored:** the agent's replies and the session transcript. From its input the stop hook reads only the session id and the working directory.

**Where sensitive data could end up:**

- A secret typed into a prompt is saved in `prompts.jsonl` as typed.
- A secrets file in the working tree that is not gitignored is copied into the baseline snapshot and, if it is inside the app directory, into `envs/`. Gitignored files are skipped.
- By default `git push` does not send the baseline ref. `git push --mirror` would.

To remove everything:

```sh
rm -rf .git/counterpatch
git update-ref -d refs/counterpatch/baseline
npx counterpatch clean
```

`clean` on its own leaves the prompt log and the baseline in place.

## How it works

**Snapshot.** `snapshot` stages the whole working tree into a private index file, writes it as a git tree, and stores it under `refs/counterpatch/baseline`. Your own index, staging area and working tree are not touched. The baseline is the tree on disk, not `HEAD`, so uncommitted work that existed before the task is part of "before" rather than being blamed on the agent.

**Environments.** `verify` snapshots the working tree again, then materializes both trees into separate directories keyed by tree id, runs each snapshot's install command, and builds. Completed environments are cached, so a later run against the same baseline reuses the control build. Dependencies are never copied from the checkout, where they may be stale even when the lockfile matches.

Installation and building receive a private database path (`.counterpatch-build.sqlite` inside the snapshot directory); the database is seeded before the build. Running apps use separate databases in the run directory. A lock per tree coordinates preparation across CLI processes, and the cache becomes ready only after all preparation succeeds. Older caches without build-time database isolation are rebuilt. Command timeouts and CLI interruption terminate subprocess groups and release preparation locks. A forced termination such as `SIGKILL` can leave a stale lock; the lock timeout identifies its path for removal once no run is active.

**Probes.** Each probe runs on both sides from a freshly seeded database and a fresh browser context. A probe is data, not code: a fixed set of steps (`goto`, `click`, `fill`, `waitFor`, `waitForUrl`, `capture`) and expectations over the evidence. See [probes/shop/](probes/shop/) for examples and [src/probe.ts](src/probe.ts) for the schema.

**Evidence.** Every run records three things, in a form that compares cleanly between the two sides:

- `ui` — the final URL path and any captured values
- `network` — each same-origin API call with method, path, status and JSON bodies
- `db` — the rows returned by the manifest's observable queries, and which rows the probe added or removed

Expectations address evidence by path and can compare one observation with another, which is how a displayed total is checked against the stored one:

```json
{ "path": "ui.captures.orderTotal", "equalsPath": "db.orders.added[0].total_cents" }
```

**Verdicts.**

| Verdict | Control | Candidate | Meaning |
| --- | --- | --- | --- |
| held | pass | pass | Behaviour preserved. Evidence that changed anyway is flagged. |
| diverged | pass | fail | A counterexample. |
| discarded (legacy JSON label) | fail | pass or fail | Preservation is unverified; the baseline may have an existing defect or the probe may be invalid. |
| candidate-only | not run | pass or fail | The probe exercises behaviour that only exists after the change. |

A candidate-only failure has no baseline to validate the probe against, so it is reported separately from a counterexample.

CounterPatch never reports a change as safe. The strongest result is "no counterexample discovered", alongside what was checked.

## The manifest

The app under test declares how to run it and what can be observed in `counterpatch.manifest.json`: install, build, start and database-reset commands, the readiness path, the selector that marks a page as interactive, which network paths to record, read-only SQL observables, plus routes, test users and fixtures for writing probes without guessing. See [demo-app/counterpatch.manifest.json](demo-app/counterpatch.manifest.json) and [src/manifest.ts](src/manifest.ts).

Each side is run with its own copy of the manifest, so a change that alters the schema is observed with its own queries.

Optional command deadlines are specified in milliseconds. These are the defaults; omit any field to keep its default:

```json
"timeouts": {
  "installMs": 300000,
  "buildMs": 300000,
  "resetDatabaseMs": 60000
}
```

`readiness.timeoutMs` separately limits how long the started app has to return a successful readiness response (default 60000 ms). A command timeout is reported with its phase and log path.

## Layout

| Path | Contents |
| --- | --- |
| [src/snapshot.ts](src/snapshot.ts) | Baseline and candidate snapshots, tree materialization |
| [src/contract.ts](src/contract.ts) | Task contracts, probe links, requirement assessments and coverage gaps |
| [src/draft-contract.ts](src/draft-contract.ts) | Model contract drafts, quoted request evidence and unresolved questions |
| [src/bundle.ts](src/bundle.ts) | Verification input capture, hashes and retained Git snapshot references |
| [src/generate.ts](src/generate.ts) | Snapshot context, generation instructions, probe validation and saving |
| [src/model.ts](src/model.ts) | Configurable chat-completions client for OpenRouter and compatible providers |
| [src/env.ts](src/env.ts) | Preparing, starting and stopping an environment |
| [src/runner.ts](src/runner.ts) | Running one probe in a browser and collecting evidence |
| [src/evidence.ts](src/evidence.ts) | Evidence paths, expectations, differences |
| [src/verify.ts](src/verify.ts) | Orchestration and verdicts |
| [src/report.ts](src/report.ts) | Terminal report |
| [src/html-report.ts](src/html-report.ts) | Report page for one run |
| [src/hooks.ts](src/hooks.ts) | Session hooks: prompt log, task state, verification on stop |
| [examples/](examples/) | Hook settings for Claude Code |
| [demo-app/](demo-app/) | The demo shop: products, cart, guest and signed-in checkout |
| [probes/shop/](probes/shop/) | Probes that hold against the unmodified demo shop |
| [test/](test/) | Unit tests, the end-to-end test and its fixtures |

## Limits

- Probes run one after another, and a step that never succeeds waits 2 seconds before failing, so a run with many failures is slow.
- Each probe runs once per side. A flaky probe can show up as a divergence.
- The demo shop is a test fixture, not a hardened application. Guest order confirmations are reachable by id.
- One task per repository at a time. A prompt from a second session replaces the open task and its baseline.
- The hand-written probes live in the repository, where the agent being checked can read and edit them.
- The hooks are tested by invoking them with the JSON Claude Code documents, not inside a live Claude Code session.
- Control and candidate run as local processes on the developer's machine. The app's install, build and start commands run unsandboxed.
- Windows is not supported.
