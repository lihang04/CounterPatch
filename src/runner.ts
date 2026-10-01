import Database from "better-sqlite3";
import path from "node:path";
import type { Browser, Page, Request } from "playwright";
import type { RunningEnv } from "./env.ts";
import {
  checkExpectation,
  parseMoney,
  type DbObservation,
  type Evidence,
  type ExpectationResult,
  type NetworkCall,
} from "./evidence.ts";
import type { Probe, Step } from "./probe.ts";

// The app under test runs locally and answers in milliseconds, so a step that
// has not succeeded by now will not; every failing probe pays this wait.
const STEP_TIMEOUT_MS = 2_000;
// How long after an interaction a request may still start and be waited for.
const SETTLE_QUIET_MS = 100;

export type StepFailure = { index: number; step: Step; message: string };

export type ProbeRun = {
  status: "pass" | "fail";
  stepFailure: StepFailure | null;
  expectations: ExpectationResult[];
  evidence: Evidence;
  screenshot: string | null;
  durationMs: number;
};

type Rows = Record<string, unknown[] | { error: string }>;

function observeDatabase(env: RunningEnv): Rows {
  const observed: Rows = {};
  let db: Database.Database;
  try {
    db = new Database(env.dbPath, { readonly: true, fileMustExist: true });
  } catch (error) {
    const message = `Could not open ${env.dbPath}: ${(error as Error).message}`;
    for (const name of Object.keys(env.manifest.database.observables)) observed[name] = { error: message };
    return observed;
  }
  try {
    for (const [name, sql] of Object.entries(env.manifest.database.observables)) {
      try {
        observed[name] = db.prepare(sql).all();
      } catch (error) {
        observed[name] = { error: (error as Error).message };
      }
    }
  } finally {
    db.close();
  }
  return observed;
}

// Rows present in `after` but not in `before`, compared as multisets.
function rowsAdded(before: unknown[], after: unknown[]): unknown[] {
  const remaining = new Map<string, number>();
  for (const row of before) {
    const key = JSON.stringify(row);
    remaining.set(key, (remaining.get(key) ?? 0) + 1);
  }
  return after.filter((row) => {
    const key = JSON.stringify(row);
    const count = remaining.get(key) ?? 0;
    if (count > 0) remaining.set(key, count - 1);
    return count === 0;
  });
}

function databaseEvidence(before: Rows, after: Rows): Record<string, DbObservation> {
  const db: Record<string, DbObservation> = {};
  for (const [name, rows] of Object.entries(after)) {
    const earlier = before[name];
    if (!Array.isArray(rows)) db[name] = rows;
    else if (!Array.isArray(earlier)) db[name] = earlier ?? { error: "Not observed before the probe." };
    else db[name] = { rows, added: rowsAdded(earlier, rows), removed: rowsAdded(rows, earlier) };
  }
  return db;
}

function parseBody(text: string | null): unknown {
  if (text === null || text === "") return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// Records same-origin requests under the manifest's network prefixes, in the
// order they were sent.
function trackNetwork(page: Page, env: RunningEnv) {
  const calls: NetworkCall[] = [];
  const pending = new Set<Promise<void>>();
  const origin = new URL(env.baseUrl).origin;

  page.on("request", (request: Request) => {
    const url = new URL(request.url());
    if (url.origin !== origin) return;
    if (!env.manifest.network.include.some((prefix) => url.pathname.startsWith(prefix))) return;

    const call: NetworkCall = {
      method: request.method(),
      path: url.pathname + url.search,
      status: null,
      requestBody: parseBody(request.postData()),
      responseBody: null,
    };
    calls.push(call);

    const done = (async () => {
      const response = await request.response();
      if (!response) {
        call.failure = request.failure()?.errorText ?? "No response";
        return;
      }
      call.status = response.status();
      // The body is gone if the page navigated away first; the status still stands.
      call.responseBody = parseBody(await response.text().catch(() => null));
    })().catch((error: Error) => {
      call.failure = error.message;
    });
    pending.add(done);
    void done.finally(() => pending.delete(done));
  });

  // Waits until no tracked request has been in flight for a short quiet period.
  const settle = async () => {
    const deadline = Date.now() + STEP_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, SETTLE_QUIET_MS));
      if (pending.size === 0) return;
      await Promise.race([
        Promise.all(pending),
        new Promise((resolve) => setTimeout(resolve, Math.max(0, deadline - Date.now()))),
      ]);
    }
  };

  return { calls, settle };
}

function pathPattern(glob: string): RegExp {
  const escaped = glob.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", "[^/]+");
  return new RegExp(`^${escaped}$`);
}

async function runStep(
  page: Page,
  env: RunningEnv,
  step: Step,
  captures: Record<string, string | number>,
  settle: () => Promise<void>,
): Promise<void> {
  const byTestId = (testId: string) =>
    page.locator(`[${env.manifest.ui.testIdAttribute}=${JSON.stringify(testId)}]`);
  const waitInteractive = async () => {
    const selector = env.manifest.ui.readySelector;
    if (selector) await page.locator(selector).first().waitFor({ state: "attached" });
  };

  switch (step.do) {
    case "goto":
      await page.goto(step.path, { waitUntil: "load" });
      await waitInteractive();
      return;
    case "click":
      await byTestId(step.testId).click();
      await settle();
      return;
    case "fill":
      await byTestId(step.testId).fill(step.value);
      return;
    case "waitForUrl": {
      const pattern = pathPattern(step.path);
      await page.waitForURL((url) => pattern.test(url.pathname));
      await waitInteractive();
      return;
    }
    case "waitFor": {
      const locator = byTestId(step.testId);
      await locator.waitFor({ state: "visible" });
      if (step.text !== undefined) {
        const wanted = step.text;
        const deadline = Date.now() + STEP_TIMEOUT_MS;
        let seen = "";
        while (Date.now() < deadline) {
          seen = ((await locator.textContent()) ?? "").trim();
          if (seen === wanted) return;
          await page.waitForTimeout(50);
        }
        throw new Error(`"${step.testId}" shows ${JSON.stringify(seen)}, expected ${JSON.stringify(wanted)}.`);
      }
      return;
    }
    case "capture": {
      const text = ((await byTestId(step.testId).textContent()) ?? "").trim();
      if (step.parse === "text") {
        captures[step.as] = text;
        return;
      }
      const value = step.parse === "money" ? parseMoney(text) : text === "" ? null : Number(text);
      if (value === null || Number.isNaN(value)) {
        throw new Error(`"${step.testId}" shows ${JSON.stringify(text)}, which is not a ${step.parse} value.`);
      }
      captures[step.as] = value;
      return;
    }
  }
}

// Says what was missing and where the browser actually was, e.g. after an
// unexpected redirect, instead of Playwright's bare "Timeout exceeded".
function describeFailure(error: unknown, step: Step, page: Page): string {
  const message = error instanceof Error ? error.message : String(error);
  if (!(error instanceof Error) || error.name !== "TimeoutError") return message.split("\n")[0] ?? message;
  const seconds = STEP_TIMEOUT_MS / 1000;
  const where = page.url().startsWith("http") ? new URL(page.url()).pathname : page.url();
  if (step.do === "waitForUrl") return `the page never reached ${step.path}; it stayed on ${where}`;
  if (step.do === "goto") return `${step.path} did not finish loading and become interactive`;
  return `no usable "${step.testId}" element within ${seconds}s on ${where}`;
}

// Runs one probe against one environment from a freshly seeded database and a
// fresh browser context, and returns everything it observed.
export async function runProbe(
  browser: Browser,
  env: RunningEnv,
  probe: Probe,
  artifactsDir: string,
): Promise<ProbeRun> {
  const started = Date.now();
  await env.resetDatabase();
  const before = observeDatabase(env);

  const context = await browser.newContext({ baseURL: env.baseUrl });
  context.setDefaultTimeout(STEP_TIMEOUT_MS);
  context.setDefaultNavigationTimeout(STEP_TIMEOUT_MS * 3);
  const page = await context.newPage();
  const { calls, settle } = trackNetwork(page, env);
  const captures: Record<string, string | number> = {};

  let stepFailure: StepFailure | null = null;
  let screenshot: string | null = null;
  let url = "";
  try {
    for (const [index, step] of probe.steps.entries()) {
      try {
        await runStep(page, env, step, captures, settle);
      } catch (error) {
        stepFailure = { index, step, message: describeFailure(error, step, page) };
        break;
      }
    }
    await settle();
    // Paths only, so control and candidate (different ports) stay comparable.
    const location = new URL(page.url());
    url = location.protocol.startsWith("http") ? location.pathname + location.search : page.url();
    const file = path.join(artifactsDir, `${probe.id}.${env.role}.png`);
    screenshot = await page.screenshot({ path: file, fullPage: true }).then(
      () => file,
      () => null,
    );
  } finally {
    await context.close();
  }

  const last: Record<string, NetworkCall> = {};
  for (const call of calls) last[`${call.method} ${call.path}`] = call;

  const evidence: Evidence = {
    ui: { url, captures },
    network: { calls, last },
    db: databaseEvidence(before, observeDatabase(env)),
  };
  const expectations = probe.expect.map((expectation) => checkExpectation(evidence, expectation));
  const passed = stepFailure === null && expectations.every((result) => result.ok);

  return {
    status: passed ? "pass" : "fail",
    stepFailure,
    expectations,
    evidence,
    screenshot,
    durationMs: Date.now() - started,
  };
}
