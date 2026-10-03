// End-to-end check of the session hooks through the real CLI, the way a
// coding agent invokes them: JSON on stdin, JSON (or nothing) on stdout.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { exec, ExecError } from "../src/exec.ts";
import { copyDemoShop, fixtures, projectRoot, shopProbes } from "./support.ts";

const cli = path.join(projectRoot, "bin", "counterpatch.mjs");
const buggyPatch = path.join(fixtures, "coupons-buggy.patch");
const probeArgs = ["guest-checkout.json", "authenticated-checkout.json"].flatMap((name) => [
  "--probes",
  path.join(shopProbes, name),
]);

async function main() {
  const sandbox = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "counterpatch-hooks-e2e-")));
  const repo = path.join(sandbox, "shop");
  const git = (...args: string[]) => exec("git", args, { cwd: repo });

  // This test may itself run inside a coding-agent session, so the project
  // directory is always set explicitly rather than inherited.
  const run = async (args: string[], input: unknown, projectDir: string | undefined = repo) => {
    const env: NodeJS.ProcessEnv = { ...process.env, COUNTERPATCH_HOME: path.join(sandbox, "home") };
    delete env.CLAUDE_PROJECT_DIR;
    if (projectDir !== undefined) env.CLAUDE_PROJECT_DIR = projectDir;
    try {
      const { stdout } = await exec(cli, args, {
        cwd: sandbox,
        env,
        input: typeof input === "string" ? input : JSON.stringify(input),
      });
      return { code: 0, stdout };
    } catch (error) {
      if (error instanceof ExecError) return { code: error.code, stdout: error.stdout };
      throw error;
    }
  };
  const userMessage = (stdout: string): string => {
    const parsed = JSON.parse(stdout) as { systemMessage?: unknown };
    assert.deepEqual(Object.keys(parsed), ["systemMessage"]);
    assert.equal(typeof parsed.systemMessage, "string");
    return parsed.systemMessage as string;
  };
  const session = { session_id: "e2e-session", hook_event_name: "UserPromptSubmit", cwd: repo };
  const status = async () => (await run(["status", "--repo", repo], "")).stdout;

  try {
    await copyDemoShop(repo);
    await git("init", "--quiet");
    await git("add", "--all");
    await git("-c", "user.name=e2e", "-c", "user.email=e2e@localhost", "commit", "--quiet", "-m", "initial");

    // Failures reach the user as a message and never as exit code 2, which
    // would make the agent discard the prompt or refuse to stop.
    const notJson = await run(["hook", "prompt"], "this is not json");
    assert.equal(notJson.code, 0);
    assert.match(userMessage(notJson.stdout), /prompt hook failed: Hook input is not valid JSON/);
    const notARepo = await run(["hook", "prompt"], { ...session, cwd: sandbox, prompt: "hi" }, sandbox);
    assert.equal(notARepo.code, 0);
    assert.match(userMessage(notARepo.stdout), /is not inside a git repository/);
    const noProbes = await run(["hook", "stop"], session);
    assert.equal(noProbes.code, 0);
    assert.match(userMessage(noProbes.stdout), /hook stop needs at least one --probes/);

    // A prompt is captured silently: anything printed would enter the agent's context.
    const prompt = await run(["hook", "prompt"], { ...session, prompt: "Add percentage coupons. Guest checkout must keep working." });
    assert.deepEqual(prompt, { code: 0, stdout: "" });
    assert.match(await status(), /Open task: session e2e-session, started .*, 1 prompt\(s\) captured/);

    // Without CLAUDE_PROJECT_DIR the repository is found from the hook input's cwd.
    const followUp = await run(["hook", "prompt"], { ...session, prompt: "Coupons must not stack." }, undefined);
    assert.deepEqual(followUp, { code: 0, stdout: "" });
    assert.match(await status(), /2 prompt\(s\) captured/);
    assert.match(await status(), /No changes since the baseline/);

    // The agent ships the buggy change and stops.
    await git("apply", buggyPatch);
    const started = Date.now();
    const broken = await run(["hook", "stop", ...probeArgs], { ...session, hook_event_name: "Stop" });
    console.error(`stop hook on the buggy change took ${((Date.now() - started) / 1000).toFixed(1)}s`);
    assert.equal(broken.code, 0);
    const report = userMessage(broken.stdout);
    console.log(report);
    assert.match(report, /1 counterexample\(s\)/);
    assert.match(report, /Guest checkout completes an order/);
    assert.match(report, /AFTER {3}failed — ended on \/login/);
    assert.match(await status(), /Open task: session e2e-session/);

    // The change is replaced by a harmless one; the next stop finds nothing and ends the task.
    await git("apply", "--reverse", buggyPatch);
    await fs.appendFile(path.join(repo, "app", "globals.css"), "\n/* harmless */\n");
    const clean = await run(["hook", "stop", ...probeArgs], { ...session, hook_event_name: "Stop" });
    assert.equal(clean.code, 0);
    assert.match(userMessage(clean.stdout), /No counterexample discovered/);
    assert.doesNotMatch(await status(), /Open task/);

    // With no open task, stopping is silent and runs nothing.
    assert.deepEqual(await run(["hook", "stop", ...probeArgs], { ...session, hook_event_name: "Stop" }), { code: 0, stdout: "" });

    console.log("hooks e2e: PASS");
  } finally {
    await fs.rm(sandbox, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
