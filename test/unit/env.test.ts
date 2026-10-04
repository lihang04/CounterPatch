import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { EnvError, prepareEnv } from "../../src/env.ts";
import { exec } from "../../src/exec.ts";
import { snapshotWorkingTree } from "../../src/snapshot.ts";

async function fixture() {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "counterpatch-env-")));
  const repo = path.join(dir, "repo");
  const home = path.join(dir, "home");
  await fs.mkdir(repo);
  await exec("git", ["init", "--quiet"], { cwd: repo });
  await fs.writeFile(path.join(repo, ".gitignore"), "node_modules/\n");
  await fs.writeFile(path.join(repo, "counterpatch.manifest.json"), JSON.stringify({
    name: "test", framework: "nextjs",
    commands: { install: "node install.cjs", start: "true", resetDatabase: "true" },
    readiness: { path: "/" }, network: { include: ["/api/"] }, database: { observables: {} },
  }));
  await fs.writeFile(path.join(repo, "install.cjs"), `
    const fs = require('node:fs');
    const version = fs.readFileSync('package-lock.json', 'utf8');
    fs.mkdirSync('node_modules', { recursive: true });
    fs.writeFileSync('node_modules/version.txt', version);
    fs.writeFileSync('installed.txt', 'installed');
  `);
  await fs.writeFile(path.join(repo, "package-lock.json"), "version-1");
  await fs.mkdir(path.join(repo, "node_modules"));
  await fs.writeFile(path.join(repo, "node_modules", "version.txt"), "stale checkout dependencies");
  const prepare = async () => prepareEnv({ role: "candidate", repoRoot: repo, tree: await snapshotWorkingTree(repo), home });
  return { dir, repo, home, prepare };
}

async function updateManifest(repo: string, changes: Record<string, unknown>) {
  const file = path.join(repo, "counterpatch.manifest.json");
  await fs.writeFile(file, JSON.stringify({ ...JSON.parse(await fs.readFile(file, "utf8")), ...changes }));
}

async function waitForFile(file: string) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await fs.stat(file).then(() => true, () => false)) return;
    await delay(20);
  }
  assert.fail(`Timed out waiting for fixture file ${file}`);
}

async function assertUnpublished(home: string, tree: string) {
  for (const suffix of ["ready", "lock"]) {
    await assert.rejects(fs.stat(path.join(home, "envs", `${tree}.${suffix}`)), { code: "ENOENT" });
  }
}

test("fresh environments install snapshot dependencies instead of copying stale checkout modules", async (t) => {
  const { dir, repo, prepare } = await fixture();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const first = await prepare();
  assert.equal(await fs.readFile(path.join(first.dir, "node_modules", "version.txt"), "utf8"), "version-1");
  assert.equal(await fs.readFile(path.join(first.dir, "installed.txt"), "utf8"), "installed");
  assert.equal(first.reused, false);

  // The checkout lockfile changes while its installed modules stay stale.
  await fs.writeFile(path.join(repo, "package-lock.json"), "version-2");
  const second = await prepare();
  assert.equal(await fs.readFile(path.join(second.dir, "node_modules", "version.txt"), "utf8"), "version-2");
  assert.notEqual(second.tree, first.tree);
  assert.equal((await prepare()).reused, true);
});

test("legacy environment caches are rebuilt with a fresh installation", async (t) => {
  const { dir, home, prepare } = await fixture();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const first = await prepare();
  await fs.writeFile(path.join(first.dir, "node_modules", "version.txt"), "legacy stale dependencies");
  await fs.writeFile(path.join(home, "envs", `${first.tree}.ready`), new Date().toISOString());

  const rebuilt = await prepare();
  assert.equal(rebuilt.reused, false);
  assert.equal(await fs.readFile(path.join(rebuilt.dir, "node_modules", "version.txt"), "utf8"), "version-1");
});

test("install failures are reported and never cached as ready", async (t) => {
  const { dir, repo, home, prepare } = await fixture();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(repo, "install.cjs"), "process.exit(7);");
  const tree = await snapshotWorkingTree(repo);
  await assert.rejects(prepare(), (error: unknown) =>
    error instanceof EnvError && error.role === "candidate" && error.phase === "install" && error.message.includes("7"),
  );
  await assert.rejects(fs.stat(path.join(home, "envs", `${tree}.ready`)), { code: "ENOENT" });
});

test("both snapshots isolate install, reset and build database access from the parent environment", async (t) => {
  const { dir, repo, home } = await fixture();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const databaseVariable = "COUNTERPATCH_TEST_DATABASE_PATH";
  const portVariable = "COUNTERPATCH_TEST_PORT";
  const previousDatabase = process.env[databaseVariable];
  const previousPort = process.env[portVariable];
  t.after(() => {
    if (previousDatabase === undefined) delete process.env[databaseVariable];
    else process.env[databaseVariable] = previousDatabase;
    if (previousPort === undefined) delete process.env[portVariable];
    else process.env[portVariable] = previousPort;
  });
  const developerDatabase = path.join(dir, "developer.sqlite");
  await fs.writeFile(developerDatabase, "developer database must stay unchanged\n");
  process.env[databaseVariable] = developerDatabase;
  process.env[portVariable] = "4567";
  await updateManifest(repo, {
    env: { databasePath: databaseVariable, port: portVariable },
    commands: {
      install: "node phase.cjs install", resetDatabase: "node phase.cjs reset",
      build: "node phase.cjs build", start: "true",
    },
  });
  await fs.writeFile(path.join(repo, "phase.cjs"), `
    const fs = require('node:fs');
    const phase = process.argv[2];
    const dbPath = process.env.${databaseVariable};
    fs.appendFileSync(dbPath, phase + '\\n');
    fs.appendFileSync('phases.jsonl', JSON.stringify({ phase, dbPath, port: process.env.${portVariable} }) + '\\n');
    if (phase === 'build' && !fs.readFileSync(dbPath, 'utf8').includes('reset\\n')) process.exit(19);
  `);
  const controlTree = await snapshotWorkingTree(repo);
  await fs.writeFile(path.join(repo, "change.txt"), "candidate snapshot\n");
  const candidateTree = await snapshotWorkingTree(repo);
  const [control, candidate] = await Promise.all([
    prepareEnv({ role: "control", repoRoot: repo, tree: controlTree, home }),
    prepareEnv({ role: "candidate", repoRoot: repo, tree: candidateTree, home }),
  ]);
  assert.notEqual(control.dir, candidate.dir);
  for (const prepared of [control, candidate]) {
    const phases = (await fs.readFile(path.join(prepared.dir, "phases.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(phases.map((entry) => entry.phase), ["install", "reset", "build"]);
    const databasePaths = new Set(phases.map((entry) => entry.dbPath));
    assert.equal(databasePaths.size, 1, "all preparation phases must share their isolated database");
    const dbPath = phases[0].dbPath as string;
    assert.equal(path.dirname(dbPath), prepared.dir);
    assert.equal(await fs.readFile(dbPath, "utf8"), "install\nreset\nbuild\n");
    assert.ok(phases.every((entry) => entry.port === "0"));
  }
  assert.equal(await fs.readFile(developerDatabase, "utf8"), "developer database must stay unchanged\n");
});

test("separate processes preparing the same snapshot share one completed environment", async (t) => {
  const { dir, repo, home } = await fixture();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const started = path.join(dir, "install-started");
  const installs = path.join(dir, "installs.txt");
  await fs.writeFile(path.join(repo, "install.cjs"), `
    const fs = require('node:fs');
    fs.appendFileSync(${JSON.stringify(installs)}, 'installed\\n');
    fs.writeFileSync(${JSON.stringify(started)}, 'started');
    fs.writeFileSync('keep.txt', 'first installer owns this directory');
    setTimeout(() => {
      if (fs.readFileSync('keep.txt', 'utf8') !== 'first installer owns this directory') process.exit(20);
      fs.writeFileSync('complete.txt', 'finished');
    }, 500);
  `);
  const tree = await snapshotWorkingTree(repo);
  const worker = path.join(dir, "prepare.mjs");
  await fs.writeFile(worker, `
    import { prepareEnv } from ${JSON.stringify(new URL("../../src/env.ts", import.meta.url).href)};
    const prepared = await prepareEnv(${JSON.stringify({ role: "candidate", repoRoot: repo, tree, home, lockTimeoutMs: 5_000 })});
    process.stdout.write(JSON.stringify({ reused: prepared.reused, dir: prepared.dir }));
  `);
  const args = ["--import", import.meta.resolve("tsx"), worker];
  const firstRun = exec(process.execPath, args);
  void firstRun.catch(() => {});
  await waitForFile(started);
  const results = await Promise.all([firstRun, exec(process.execPath, args)]);
  const prepared = results.map((result) => JSON.parse(result.stdout));
  assert.deepEqual(prepared.map((result) => result.reused), [false, true]);
  assert.equal(prepared[0].dir, prepared[1].dir);
  assert.equal(await fs.readFile(installs, "utf8"), "installed\n");
  assert.equal(await fs.readFile(path.join(prepared[0].dir, "complete.txt"), "utf8"), "finished");
  await assert.rejects(fs.stat(path.join(home, "envs", `${tree}.lock`)), { code: "ENOENT" });
});

for (const [phase, timeoutKey] of [["install", "installMs"], ["reset-database", "resetDatabaseMs"], ["build", "buildMs"]] as const) {
  test(`${phase} timeouts leave no ready cache or lock and the same snapshot can be retried`, async (t) => {
    const { dir, repo, home } = await fixture();
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const stall = path.join(dir, "stall");
    await fs.writeFile(stall, "stall");
    await fs.writeFile(path.join(repo, "phase.cjs"), `
      const fs = require('node:fs');
      if (process.argv[2] === ${JSON.stringify(phase)} && fs.existsSync(${JSON.stringify(stall)})) setInterval(() => {}, 1000);
    `);
    await updateManifest(repo, {
      commands: {
        install: "node phase.cjs install", resetDatabase: "node phase.cjs reset-database",
        build: "node phase.cjs build", start: "true",
      },
      timeouts: { [timeoutKey]: 300 },
    });
    const tree = await snapshotWorkingTree(repo);
    const options = { role: "candidate" as const, repoRoot: repo, tree, home, lockTimeoutMs: 1_000 };
    await assert.rejects(prepareEnv(options), (error: unknown) =>
      error instanceof EnvError && error.phase === phase && /timed out/.test(error.message),
    );
    await assertUnpublished(home, tree);
    await fs.rm(stall);
    assert.equal((await prepareEnv(options)).reused, false);
  });
}

test("cancelling preparation releases its lock without publishing an incomplete environment", async (t) => {
  const { dir, repo, home } = await fixture();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const started = path.join(dir, "started");
  const stall = path.join(dir, "stall");
  await fs.writeFile(stall, "stall");
  await fs.writeFile(path.join(repo, "install.cjs"), `
    const fs = require('node:fs');
    fs.writeFileSync(${JSON.stringify(started)}, 'started');
    if (fs.existsSync(${JSON.stringify(stall)})) setInterval(() => {}, 1000);
  `);
  await updateManifest(repo, { timeouts: { installMs: 5_000 } });
  const tree = await snapshotWorkingTree(repo);
  const options = { role: "candidate" as const, repoRoot: repo, tree, home, lockTimeoutMs: 1_000 };
  const controller = new AbortController();
  t.after(() => controller.abort());
  const rejected = assert.rejects(prepareEnv({ ...options, signal: controller.signal }), (error: unknown) =>
    error instanceof EnvError && error.phase === "install" && /cancelled/.test(error.message),
  );
  await waitForFile(started);
  controller.abort();
  await rejected;
  await assertUnpublished(home, tree);
  await fs.rm(stall);
  assert.equal((await prepareEnv(options)).reused, false);
});
