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
| Capturing the user's prompts from the coding-agent session | Not started |
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
npm test        # unit tests: snapshots, evidence paths, probe validation
npm run e2e     # full pipeline against a deliberately buggy change (about 45 s)
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
| `verify` | Builds and runs control and candidate, runs the probes, prints the report. `--json` prints the full evidence. |
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
          step 5 (fill checkout-email): no usable "checkout-email" element within 5s on /login
  Observed differences (control → candidate):
    ui.url: "/order/1" → "/login"

? Coupon total shown at checkout is the total that is charged  [coupon-total-consistency]
  AFTER   failed — ended on /order/1; …
          Stored order total equals the total displayed at checkout — db.orders.added[0].total_cents is 8000, ui.captures.checkoutTotal is 7200
```

## How it works

**Snapshot.** `snapshot` stages the whole working tree into a private index file, writes it as a git tree, and stores it under `refs/counterpatch/baseline`. Your own index, staging area and working tree are not touched. The baseline is the tree on disk, not `HEAD`, so uncommitted work that existed before the task is part of "before" rather than being blamed on the agent.

**Environments.** `verify` snapshots the working tree again, then materializes both trees into separate directories keyed by tree id, installs dependencies, and builds. If the lockfile matches your checkout, `node_modules` is cloned from it instead of reinstalled. Because directories are keyed by tree id, a later run against the same baseline reuses the control build.

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
| [demo-app/](demo-app/) | The demo shop: products, cart, guest and signed-in checkout |
| [probes/shop/](probes/shop/) | Probes that hold against the unmodified demo shop |
| [test/](test/) | Unit tests, the end-to-end test and its fixtures |

## Limits

- Probes run one after another, and a step that never succeeds waits 5 seconds before failing, so a run with many failures is slow.
- Each probe runs once per side. A flaky probe can show up as a divergence.
- The demo shop is a test fixture, not a hardened application. Guest order confirmations are reachable by id.
- Control and candidate run as local processes on the developer's machine. The app's install, build and start commands run unsandboxed.
- Windows is not supported.
