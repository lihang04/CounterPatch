import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { killAllProcesses, runLoggedCommand } from "../../src/process.ts";

const shellQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

async function fixture(t: TestContext) {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "counterpatch-process-")));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return { dir, options: { cwd: dir, env: process.env, logPath: path.join(dir, "command.log"), timeoutMs: 5_000 } };
}

async function waitUntil(predicate: () => Promise<boolean>, description: string) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(20);
  }
  assert.fail(`Timed out waiting for ${description}`);
}

function isAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

async function processFamily(t: TestContext) {
  const { dir, options } = await fixture(t);
  await fs.writeFile(path.join(dir, "descendant.cjs"), `
    const fs = require('node:fs');
    fs.writeFileSync('descendant.pid', String(process.pid));
    process.on('SIGTERM', () => {});
    setInterval(() => {}, 1000);
  `);
  await fs.writeFile(path.join(dir, "parent.cjs"), `
    const fs = require('node:fs');
    fs.writeFileSync('parent.pid', String(process.pid));
    require('node:child_process').spawn(process.execPath, ['descendant.cjs'], { stdio: 'inherit' });
    process.on('SIGTERM', () => {});
    setInterval(() => {}, 1000);
  `);
  t.after(async () => {
    for (const name of ["parent", "descendant"]) {
      const pid = Number(await fs.readFile(path.join(dir, `${name}.pid`), "utf8").catch(() => "0"));
      if (pid > 0) {
        try { process.kill(pid, "SIGKILL"); } catch { /* already reaped */ }
      }
    }
  });
  const ready = async () => {
    await waitUntil(() => fs.stat(path.join(dir, "descendant.pid")).then(() => true, () => false), "descendant startup");
    return Promise.all(["parent", "descendant"].map(async (name) => Number(await fs.readFile(path.join(dir, `${name}.pid`), "utf8"))));
  };
  return { options: { ...options, command: `${shellQuote(process.execPath)} parent.cjs` }, ready };
}

test("command timeouts terminate the entire subprocess group", async (t) => {
  const { options, ready } = await processFamily(t);
  const rejected = assert.rejects(runLoggedCommand({ ...options, timeoutMs: 1_500 }), /timed out after 1500 ms/);
  const pids = await ready();
  assert.ok(pids.every(isAlive));
  await rejected;
  await waitUntil(async () => pids.every((pid) => !isAlive(pid)), "timed-out processes to exit");
});

test("cancelling a command terminates the entire subprocess group", async (t) => {
  const { options, ready } = await processFamily(t);
  const controller = new AbortController();
  t.after(() => controller.abort());
  const rejected = assert.rejects(runLoggedCommand({ ...options, signal: controller.signal }), /cancelled/);
  const pids = await ready();
  controller.abort();
  await rejected;
  await waitUntil(async () => pids.every((pid) => !isAlive(pid)), "cancelled processes to exit");
});

test("global cleanup also terminates preparation commands and their descendants", async (t) => {
  const { options, ready } = await processFamily(t);
  const rejected = assert.rejects(runLoggedCommand(options), /signal SIGKILL/);
  const pids = await ready();
  killAllProcesses();
  await rejected;
  await waitUntil(async () => pids.every((pid) => !isAlive(pid)), "globally cancelled processes to exit");
});

test("failed process creation rejects promptly and records the failure", async (t) => {
  const { dir, options } = await fixture(t);
  await assert.rejects(runLoggedCommand({ ...options, cwd: path.join(dir, "missing"), command: "true" }), /Could not run.*ENOENT/);
  assert.match(await fs.readFile(options.logPath, "utf8"), /\$ true/);
});

test("commands report nonzero exit status with stdout and stderr captured", async (t) => {
  const { dir, options } = await fixture(t);
  await fs.writeFile(path.join(dir, "failure.cjs"), "console.log('stdout marker'); console.error('stderr marker'); process.exit(23);");
  await assert.rejects(runLoggedCommand({ ...options, command: `${shellQuote(process.execPath)} failure.cjs` }), /code 23/);
  const log = await fs.readFile(options.logPath, "utf8");
  assert.match(log, /stdout marker/);
  assert.match(log, /stderr marker/);
});

test("a shell exiting does not leave background descendants holding its log pipes open", async (t) => {
  const { options, ready } = await processFamily(t);
  const running = runLoggedCommand({ ...options, command: `${options.command} & while [ ! -f descendant.pid ]; do sleep 0.02; done; sleep 0.1; exit 0` });
  const pids = await ready();
  await running;
  await waitUntil(async () => pids.every((pid) => !isAlive(pid)), "background descendants to exit");
});
