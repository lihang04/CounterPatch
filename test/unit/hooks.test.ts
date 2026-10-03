import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { exec } from "../../src/exec.ts";
import { onPrompt, onStop, readTask, readTaskPrompts } from "../../src/hooks.ts";
import { parseProbe } from "../../src/probe.ts";
import type { ProbeRun } from "../../src/runner.ts";
import { readBaseline, stateDir } from "../../src/snapshot.ts";
import type { Report } from "../../src/verify.ts";

let repo: string;
const git = async (...args: string[]) => (await exec("git", args, { cwd: repo })).stdout;
const write = (name: string, content: string) => fs.writeFile(path.join(repo, name), content);

const probe = parseProbe(
  { id: "guest-checkout", title: "Guest checkout completes an order", steps: [{ do: "goto", path: "/" }], expect: [{ path: "ui.url", equals: "/order/1" }] },
  "inline",
);
const run = (status: "pass" | "fail", url: string): ProbeRun => ({
  status,
  stepFailure: null,
  expectations: [{ expectation: probe.expect[0]!, ok: status === "pass", actual: url, expected: "/order/1", message: `ui.url is "${url}", expected "/order/1"` }],
  evidence: { ui: { url, captures: {} }, network: { calls: [], last: {} }, db: {} },
  screenshot: null,
  durationMs: 1,
});

async function reportWith(verdict: "held" | "diverged"): Promise<Report> {
  const baseline = await readBaseline(repo);
  assert.ok(baseline);
  return {
    outcome: "completed",
    baseline,
    changed: [{ status: "M", path: "app.txt" }],
    results: [{ probe, verdict, control: run("pass", "/order/1"), candidate: run(verdict === "held" ? "pass" : "fail", verdict === "held" ? "/order/1" : "/login"), differences: [] }],
    runDir: "/tmp/run",
    reused: { control: false, candidate: false },
  };
}

before(async () => {
  repo = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "counterpatch-hooks-")));
  await git("init", "--quiet");
  await write("app.txt", "before the task\n");
});

after(async () => {
  await fs.rm(repo, { recursive: true, force: true });
});

test("the first prompt of a session records the baseline; later prompts only add to the log", async () => {
  assert.deepEqual(await onPrompt(repo, { session_id: "s1", prompt: "Add coupons. Guest checkout must keep working." }), { startedTask: true });
  const task = await readTask(repo);
  const baseline = await readBaseline(repo);
  assert.equal(task?.sessionId, "s1");
  assert.equal(task?.baseline, baseline?.commit);
  assert.equal(await git("show", `${baseline?.tree}:app.txt`), "before the task\n");

  // The agent has edited the app by the time the user follows up.
  await write("app.txt", "agent edit\n");
  assert.deepEqual(await onPrompt(repo, { session_id: "s1", prompt: "Coupons should not stack." }), { startedTask: false });
  assert.deepEqual(await readBaseline(repo), baseline, "a follow-up prompt moved the baseline");
  assert.deepEqual(
    (await readTaskPrompts(repo)).map((entry) => entry.prompt),
    ["Add coupons. Guest checkout must keep working.", "Coupons should not stack."],
  );
  // State lives in the git directory, so it can never end up in a snapshot or a commit.
  assert.equal(await git("status", "--porcelain"), "?? app.txt\n");
  assert.ok((await stateDir(repo)).startsWith(path.join(repo, ".git")));
});

test("stop does nothing for a session that has no open task", async () => {
  let verified = false;
  const result = await onStop(repo, { session_id: "another-session" }, async () => {
    verified = true;
    return reportWith("held");
  });
  assert.deepEqual(result, { message: null, report: null });
  assert.equal(verified, false);
});

test("stop stays quiet and keeps the task open when nothing changed", async () => {
  const baseline = await readBaseline(repo);
  assert.ok(baseline);
  const result = await onStop(repo, { session_id: "s1" }, async () => ({ outcome: "unchanged", baseline }));
  assert.equal(result.message, null);
  assert.equal((await readTask(repo))?.sessionId, "s1");
});

test("a counterexample is reported and the task keeps its original baseline", async () => {
  const before = await readBaseline(repo);
  const result = await onStop(repo, { session_id: "s1" }, () => reportWith("diverged"));
  assert.match(result.message ?? "", /1 counterexample\(s\)/);
  assert.match(result.message ?? "", /Guest checkout completes an order/);
  assert.equal((await readTask(repo))?.sessionId, "s1");

  await onPrompt(repo, { session_id: "s1", prompt: "Fix guest checkout." });
  assert.deepEqual(await readBaseline(repo), before);
  assert.equal((await readTaskPrompts(repo)).length, 3);
});

test("a clean result closes the task, so the next prompt starts from the current tree", async () => {
  const result = await onStop(repo, { session_id: "s1" }, () => reportWith("held"));
  assert.match(result.message ?? "", /No counterexample discovered/);
  assert.equal(await readTask(repo), null);
  assert.deepEqual(await readTaskPrompts(repo), []);

  assert.deepEqual(await onPrompt(repo, { session_id: "s1", prompt: "Now add free shipping." }), { startedTask: true });
  const baseline = await readBaseline(repo);
  assert.equal(await git("show", `${baseline?.tree}:app.txt`), "agent edit\n");
  assert.deepEqual((await readTaskPrompts(repo)).map((entry) => entry.prompt), ["Now add free shipping."]);
});

test("a prompt from a different session starts a new task", async () => {
  await write("app.txt", "second session starts here\n");
  assert.deepEqual(await onPrompt(repo, { session_id: "s2", prompt: "Rename the shop." }), { startedTask: true });
  const baseline = await readBaseline(repo);
  assert.equal(await git("show", `${baseline?.tree}:app.txt`), "second session starts here\n");
  assert.equal((await readTask(repo))?.sessionId, "s2");
});

test("an older verification cannot close a task started by another session", async () => {
  const report = await reportWith("held");
  await onStop(repo, { session_id: "s2" }, async () => {
    await onPrompt(repo, { session_id: "s3", prompt: "Start a new task during verification." });
    return report;
  });
  assert.equal((await readTask(repo))?.sessionId, "s3");
  assert.deepEqual((await readTaskPrompts(repo)).map((entry) => entry.prompt), ["Start a new task during verification."]);
});

test("a follow-up during verification keeps the same session's task open", async () => {
  const task = await readTask(repo);
  const report = await reportWith("held");
  await onStop(repo, { session_id: "s3" }, async () => {
    await onPrompt(repo, { session_id: "s3", prompt: "Also update the cart." });
    return report;
  });
  const current = await readTask(repo);
  assert.equal(current?.sessionId, "s3");
  assert.equal(current?.baseline, task?.baseline);
  assert.notEqual(current?.revision, task?.revision);
  assert.equal((await readTaskPrompts(repo)).length, 2);
});

test("concurrent prompts create one baseline and capture both prompts", async () => {
  const results = await Promise.all([
    onPrompt(repo, { session_id: "s4", prompt: "First concurrent prompt." }),
    onPrompt(repo, { session_id: "s4", prompt: "Second concurrent prompt." }),
  ]);
  assert.equal(results.filter((result) => result.startedTask).length, 1);
  assert.equal((await readTask(repo))?.baseline, (await readBaseline(repo))?.commit);
  assert.deepEqual(
    (await readTaskPrompts(repo)).map((entry) => entry.prompt).sort(),
    ["First concurrent prompt.", "Second concurrent prompt."],
  );
});

test("malformed hook input is rejected with a clear message", async () => {
  await assert.rejects(onPrompt(repo, { prompt: "no session" }), /Unexpected UserPromptSubmit hook input/);
  await assert.rejects(onStop(repo, {}, () => reportWith("held")), /Unexpected Stop hook input/);
});
