import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
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
