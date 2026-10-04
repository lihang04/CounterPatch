import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { exec } from "../../src/exec.ts";
import { parseContract } from "../../src/contract.ts";
import { parseProbe } from "../../src/probe.ts";
import { contentHash } from "../../src/bundle.ts";
import { recordBaseline } from "../../src/snapshot.ts";
import { verify } from "../../src/verify.ts";

async function fixture(t: TestContext) {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "counterpatch-verify-")));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const repo = path.join(dir, "repo");
  const home = path.join(dir, "home");
  const started = path.join(dir, "started");
  await fs.mkdir(repo);
  await exec("git", ["init", "--quiet"], { cwd: repo });
  await fs.writeFile(path.join(repo, "counterpatch.manifest.json"), JSON.stringify({
    name: "test", framework: "nextjs",
    commands: { install: "node install.cjs", start: "true", resetDatabase: "true" },
    timeouts: { installMs: 10_000 },
    readiness: { path: "/" }, network: { include: ["/api/"] }, database: { observables: {} },
  }));
  await fs.writeFile(path.join(repo, "install.cjs"), `
    require('node:fs').appendFileSync(${JSON.stringify(started)}, String(process.pid) + '\\n');
    setInterval(() => {}, 1000);
  `);
  await recordBaseline(repo);
  return { dir, repo, home, started };
}

async function waitUntil(predicate: () => Promise<boolean>, description: string) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(20);
  }
  assert.fail(`Timed out waiting for ${description}`);
}

async function assertClean(home: string, started: string) {
  const files = await fs.readdir(path.join(home, "envs"));
  assert.ok(!files.some((file) => /\.(lock|ready)$/.test(file)), "failed preparation must release locks without publishing caches");
  const pids = (await fs.readFile(started, "utf8")).trim().split("\n").map(Number);
  await waitUntil(async () => pids.every((pid) => {
    try { process.kill(pid, 0); return false; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return true;
      throw error;
    }
  }), "install processes to exit");
}

test("a failed candidate preparation cancels and awaits the control before returning its failure", async (t) => {
  const { repo, home, started } = await fixture(t);
  await fs.writeFile(path.join(repo, "install.cjs"), `
    const fs = require('node:fs');
    const timer = setInterval(() => {
      if (fs.existsSync(${JSON.stringify(started)})) process.exit(7);
    }, 20);
    setTimeout(() => process.exit(8), 5000);
  `);
  const report = await verify({ repo, app: ".", probes: [], home });
  assert.equal(report.outcome, "environment-failed");
  if (report.outcome !== "environment-failed") assert.fail("expected preparation failure");
  assert.equal(report.failure.role, "candidate");
  assert.equal(report.failure.phase, "install");
  assert.match(report.failure.message, /code 7/);
  assert.ok(report.bundle);
  const { sha256, ...bundle } = JSON.parse(await fs.readFile(report.bundle.path, "utf8"));
  assert.equal(sha256, contentHash(bundle));
  assert.equal(sha256, report.bundle.sha256);
  assert.deepEqual(bundle.probes, []);
  assert.equal(bundle.contract, null);
  assert.equal(bundle.execution.nodeVersion, process.version);
  assert.ok(bundle.execution.verifierSourceHash);
  const refTree = (await exec("git", ["rev-parse", bundle.snapshots.refs.control], { cwd: repo })).stdout.trim();
  assert.equal(refTree, report.baseline.tree);
  await recordBaseline(repo);
  assert.equal((await exec("git", ["rev-parse", bundle.snapshots.refs.control], { cwd: repo })).stdout.trim(), refTree);
  await assertClean(home, started);
});

test("an unchanged app with a task contract still runs verification and records its contract", async (t) => {
  const { repo, home } = await fixture(t);
  await fs.writeFile(path.join(repo, "install.cjs"), "process.exit(7);");
  await recordBaseline(repo);
  const contract = parseContract({ schemaVersion: 1, title: "Require login", requirements: [
    { id: "login", kind: "change", description: "Checkout requires login" },
  ] });
  const probe = parseProbe({ id: "login", title: "Requires login", requirementId: "login", steps: [{ do: "goto", path: "/checkout" }],
    expect: [{ path: "ui.url", equals: "/login" }] }, "test");
  const report = await verify({ repo, app: ".", home, probes: [probe], contract });
  assert.equal(report.outcome, "environment-failed");
  if (report.outcome !== "environment-failed" || !report.bundle) assert.fail("expected failure with a bundle");
  const bundle = JSON.parse(await fs.readFile(report.bundle.path, "utf8"));
  assert.deepEqual(bundle.contract, contract);
  assert.deepEqual(bundle.probes, [probe]);
});

test("SIGTERM lets the CLI terminate preparation processes and release both cache locks", async (t) => {
  const { dir, repo, home, started } = await fixture(t);
  await fs.writeFile(path.join(repo, "change.txt"), "candidate change");
  const probes = path.join(dir, "probe.json");
  await fs.writeFile(probes, JSON.stringify({
    id: "test", title: "Test", steps: [{ do: "goto", path: "/" }], expect: [{ path: "ui.url", equals: "/" }],
  }));
  const child = spawn(process.execPath, [
    "--import", import.meta.resolve("tsx"), fileURLToPath(new URL("../../src/cli.ts", import.meta.url)),
    "verify", "--repo", repo, "--probes", probes,
  ], { env: { ...process.env, COUNTERPATCH_HOME: home }, stdio: "ignore" });
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  t.after(async () => { child.kill("SIGKILL"); await exited; });
  await waitUntil(async () => {
    const pids = await fs.readFile(started, "utf8").catch(() => "");
    return pids.trim().split("\n").length === 2;
  }, "both installers to start");
  child.kill("SIGTERM");
  assert.equal(await exited, 143);
  await assertClean(home, started);
});
