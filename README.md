# CounterPatch

**Your coding agent says it's done. CounterPatch makes it prove it.**

CounterPatch is an independent verifier for AI-generated code changes. It records the working tree before a coding task starts, then runs the same behavioural probes against the app as it was (control) and as it is now (candidate), and reports concrete counterexamples: things that worked before the change and do not work after it, with UI, network and database evidence.

It is scoped to one stack: **Next.js + TypeScript + SQLite + Playwright**.

## Status

The execution foundation works end to end and involves no AI yet.

| Piece | State |
| --- | --- |
| Pre-task working-tree snapshot (including uncommitted and untracked files) | Done |
| Control and candidate environments built from snapshots, started on separate ports and databases | Done |
| Probes executed through a real browser, collecting UI, network and database evidence | Done |
| Verdicts: held, diverged, discarded (broken probe), candidate-only | Done |
| Demo shop with deterministic fixtures and a manifest | Done |
| Session hooks: prompts captured and baseline recorded automatically, verification run when the agent stops | Done for Claude Code |
| Intent contract, probe generation and evidence classification (NVIDIA Nemotron) | Not started |
| Next.js structure analysis (routes, proxy matchers, server actions, `fetch` relationships) | Not started |
| Repair loop back into the coding agent | Not started |
| Isolated execution on Nebius | Not started; environments run locally |

Probes are hand-written JSON for now. A divergence is reported as an observation; deciding whether it violates the user's intent or is an intended change needs the intent contract, which is the next stage.

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
| `verify` | Builds and runs control and candidate, runs the probes, prints the report. `--json` prints the full evidence; `--open` opens the report page in the browser. |
| `clean` | Deletes cached environments and past runs. |

`verify` exits with 0 when no counterexample was discovered, 1 when one was, and 2 when an environment failed to install, build or start.

A report looks like this (shortened):

```text
COUNTERPATCH

Probes run:              7
Valid baseline probes:   5
Discarded probes:        1
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

Every completed run also writes `report.html` next to its evidence, and the terminal report ends with its path. It is one self-contained file with the screenshots embedded, so it can be opened directly or sent to someone.

The page leads with what was found, then shows each counterexample with the app before and after the change side by side and a table of what differed on the page, on the network and in the database. Counterexamples that end on the same unexpected page are grouped as one symptom, so one redirect seen by six probes reads as one finding. Probes that passed and probes that were discarded are listed below, collapsed.

Grouping is by symptom, not by cause: it says the probes ended in the same place, not that one defect is behind all of them.

## Running it from the coding-agent session

Two hooks remove the manual steps, so the agent being checked has no say in when or whether verification runs.

| Hook | Claude Code event | What it does |
| --- | --- | --- |
| `counterpatch hook prompt` | `UserPromptSubmit` | Logs the user's prompt. On the first prompt of a task, records the baseline. |
| `counterpatch hook stop` | `Stop` | Runs `verify` for the open task and shows the report to the user. |

To switch them on, merge [examples/claude-code-hooks.json](examples/claude-code-hooks.json) into `.claude/settings.local.json` (your machine only) or `.claude/settings.json` (everyone who clones the repository). They are not enabled in this repository.

A task starts at the first prompt of a session and ends when a verification finds no counterexample. Until then, follow-up prompts are judged against the same baseline, so "fix it" after a counterexample is still compared with the tree from before the original request. `counterpatch status` shows the open task. [What is stored, and where](#what-is-stored-and-where) lists what the hooks keep.

Both hooks stay out of the agent's way:

- The prompt hook prints nothing, because Claude Code adds a prompt hook's output to the agent's context.
- The stop hook reports to the user only. It does not send counterexamples back to the agent; that is the repair loop, which comes later.
- Neither hook ever exits with code 2, which Claude Code treats as "block". Failures are shown to the user as a message instead.

## What is stored, and where

Everything CounterPatch stores stays on the machine it runs on, and it sends none of it anywhere. The only network activity is the app's own install command fetching packages (`npm ci` for the demo shop) and the headless browser talking to the two local copies of the app. That changes when model calls are added: the prompts, the diff and the manifest will then be sent to the model provider.

**In the repository's git directory.** Nothing here is part of the working tree, so none of it can end up in a snapshot or a commit.

| What | Written by | Contents | Kept until |
| --- | --- | --- | --- |
| `.git/counterpatch/prompts.jsonl` | prompt hook | Every prompt submitted in a session: full text, timestamp, session id. Created readable by the owner only. | Deleted by hand |
| `.git/counterpatch/task.json` | prompt hook | Session id, start time and baseline commit of the open task | A verification finds no counterexample |
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
| Install and build log | `<home>/envs/<tree id>.prepare.log` | Output of the app's install and build commands for that snapshot, each preceded by a `$ command` line. Rewritten when the environment is prepared again; untouched when the environment is reused from the cache. |
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
| discarded | fail | — | The probe is wrong, so it is thrown away. |
| candidate-only | not run | pass or fail | The probe exercises behaviour that only exists after the change. |

A candidate-only failure has no baseline to validate the probe against, so it is reported separately from a counterexample.

CounterPatch never reports a change as safe. The strongest result is "no counterexample discovered", alongside what was checked.

## The manifest

The app under test declares how to run it and what can be observed in `counterpatch.manifest.json`: install, build, start and database-reset commands, the readiness path, the selector that marks a page as interactive, which network paths to record, read-only SQL observables, plus routes, test users and fixtures for writing probes without guessing. See [demo-app/counterpatch.manifest.json](demo-app/counterpatch.manifest.json) and [src/manifest.ts](src/manifest.ts).

Each side is run with its own copy of the manifest, so a change that alters the schema is observed with its own queries.

## Layout

| Path | Contents |
| --- | --- |
| [src/snapshot.ts](src/snapshot.ts) | Baseline and candidate snapshots, tree materialization |
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
