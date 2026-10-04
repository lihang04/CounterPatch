import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { contentHash, loadVerificationBundle, validateBundleRepository, writeVerificationBundle } from "../../src/bundle.ts";
import { exec } from "../../src/exec.ts";
import { parseProbe } from "../../src/probe.ts";
import { readBaseline, recordBaseline, snapshotWorkingTree, subtree } from "../../src/snapshot.ts";
import { replay } from "../../src/verify.ts";

async function fixture(t: TestContext) {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "counterpatch-bundle-")));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const repo = path.join(dir, "repo");
  const app = path.join(repo, "app");
  const home = path.join(dir, "home");
  const marker = path.join(dir, "installed");
  await fs.mkdir(app, { recursive: true });
  await exec("git", ["init", "--quiet"], { cwd: repo });
  await fs.writeFile(path.join(app, "counterpatch.manifest.json"), JSON.stringify({
    name: "test", framework: "nextjs", commands: { install: "node install.cjs", start: "true", resetDatabase: "true" },
    readiness: { path: "/" }, network: { include: ["/api/"] }, database: { observables: {} },
  }));
  await fs.writeFile(path.join(app, "install.cjs"), `require('node:fs').writeFileSync(${JSON.stringify(marker)}, process.cwd()); process.exit(7);`);
  const baseline = await recordBaseline(repo);
  await fs.writeFile(path.join(app, "candidate.txt"), "candidate change");
  const candidateTree = await snapshotWorkingTree(repo);
  const controlAppTree = await subtree(repo, baseline.tree, "app");
  const candidateAppTree = await subtree(repo, candidateTree, "app");
  const runDir = path.join(home, "runs", "original");
  await fs.mkdir(runDir, { recursive: true });
  const probes = [parseProbe({ id: "checkout", title: "Guest checkout", steps: [{ do: "goto", path: "/checkout" }],
    expect: [{ path: "ui.url", equals: "/checkout" }] }, "test")];
  const ref = await writeVerificationBundle({ root: repo, appPath: "app", baseline, candidateTree, controlAppTree, candidateAppTree, runDir, probes });
  const original = JSON.parse(await fs.readFile(ref.path, "utf8"));
  const changedBundle = async (change: (raw: typeof original) => void, rehash = true) => {
    const raw = structuredClone(original);
    change(raw);
    if (rehash) { const { sha256: _old, ...payload } = raw; raw.sha256 = contentHash(payload); }
    const file = path.join(dir, "changed.json");
    await fs.writeFile(file, JSON.stringify(raw));
    return file;
  };
  return { dir, repo, app, home, marker, baseline, candidateTree, ref, original, changedBundle };
}

test("bundle readers preserve old v1 inputs and detect edits before executing commands", async (t) => {
  const f = await fixture(t);
  assert.equal((await loadVerificationBundle(f.ref.path)).sha256, f.ref.sha256);
  const legacy = await f.changedBundle((raw) => { delete raw.execution.preparation; });
  assert.equal((await loadVerificationBundle(legacy)).execution.preparation, undefined);
  const changed = await f.changedBundle((raw) => { raw.probes[0].title = "Edited"; }, false);
  await assert.rejects(replay({ bundle: changed, home: f.home }), /checksum/);
  await assert.rejects(fs.stat(f.marker), { code: "ENOENT" });
});

test("recomputed digests cannot bypass schema, contract links, snapshot or manifest consistency", async (t) => {
  const f = await fixture(t);
  for (const change of [
    (raw: typeof f.original) => { raw.schemaVersion = 2; },
    (raw: typeof f.original) => { raw.appPath = "../outside"; },
    (raw: typeof f.original) => { raw.execution.probeLimits.stepTimeoutMs = 0; },
    (raw: typeof f.original) => { raw.probes[0].requirementId = "unbound"; },
    (raw: typeof f.original) => { raw.probes.push(raw.probes[0]); },
    (raw: typeof f.original) => { raw.snapshots.candidateTree = "a".repeat(40); },
    (raw: typeof f.original) => { raw.snapshots.controlAppTree = raw.snapshots.candidateAppTree; },
    (raw: typeof f.original) => { raw.manifests.candidate.commands.install = "echo changed-command"; },
  ]) await assert.rejects(replay({ bundle: await f.changedBundle(change), home: f.home }));
  await assert.rejects(fs.stat(f.marker), { code: "ENOENT" });
});

test("replay ignores current sources and baseline, prepares fresh environments and records execution differences", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.app, "install.cjs"), "process.exit(0);");
  const currentBaseline = await recordBaseline(f.repo);
  await fs.rm(f.app, { recursive: true });
  // Completed global caches are deliberately unusable; replay must build afresh.
  for (const tree of [f.original.snapshots.controlAppTree, f.original.snapshots.candidateAppTree]) {
    await fs.mkdir(path.join(f.home, "envs", tree), { recursive: true });
    await fs.writeFile(path.join(f.home, "envs", `${tree}.ready`), "3");
  }
  const input = await f.changedBundle((raw) => {
    raw.execution.nodeVersion = "v0.0.0";
    raw.execution.probeLimits = { stepTimeoutMs: 400, settleQuietMs: 20 };
  });
  const report = await replay({ bundle: input, home: f.home });
  assert.equal(report.outcome, "environment-failed");
  if (report.outcome !== "environment-failed") assert.fail("expected retained installer to fail");
  assert.equal(report.failure.phase, "install");
  assert.match(report.failure.message, /code 7/);
  assert.deepEqual(report.baseline, f.baseline);
  assert.deepEqual(await readBaseline(f.repo), currentBaseline);
  assert.ok(report.replay?.executionDrift.some((c) => c.field === "nodeVersion"));
  assert.ok((await fs.readFile(f.marker, "utf8")).startsWith(path.join(report.runDir!, "environment-cache")));
  const output = await loadVerificationBundle(report.bundle!.path);
  assert.equal(output.snapshots.candidateTree, f.candidateTree);
  assert.equal(output.execution.preparation, "fresh");
  assert.deepEqual(output.execution.probeLimits, { stepTimeoutMs: 400, settleQuietMs: 20 });
  assert.equal(output.replayOf?.sha256, report.replay?.sourceBundle.sha256);
  assert.equal((await exec("git", ["ls-files"], { cwd: f.repo })).stdout, "");
});

test("a moved repository can replay using --repo without requiring the recorded app directory", async (t) => {
  const f = await fixture(t);
  const moved = path.join(f.dir, "moved-repo");
  await fs.rename(f.repo, moved);
  await fs.rm(path.join(moved, "app"), { recursive: true });
  const loaded = await loadVerificationBundle(f.ref.path);
  assert.equal(await validateBundleRepository(loaded, moved), moved);
  const report = await replay({ bundle: f.ref.path, repo: moved, home: f.home });
  assert.equal(report.outcome, "environment-failed");
  if (report.outcome === "environment-failed") assert.equal(report.failure.phase, "install");
});
