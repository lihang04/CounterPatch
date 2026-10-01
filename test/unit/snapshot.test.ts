import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { exec } from "../../src/exec.ts";
import {
  changedFiles,
  materializeTree,
  readBaseline,
  recordBaseline,
  repoRoot,
  snapshotWorkingTree,
  subtree,
} from "../../src/snapshot.ts";

let repo: string;
const git = async (...args: string[]) => (await exec("git", args, { cwd: repo })).stdout;

before(async () => {
  repo = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "counterpatch-snapshot-")));
  await git("init", "--quiet");
  await fs.mkdir(path.join(repo, "app"));
  await fs.writeFile(path.join(repo, ".gitignore"), "ignored/\n");
  await fs.writeFile(path.join(repo, "app", "committed.txt"), "committed\n");
  await fs.writeFile(path.join(repo, "app", "edited.txt"), "at HEAD\n");
  await git("add", "--all");
  await git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "--quiet", "-m", "initial");
});

after(async () => {
  await fs.rm(repo, { recursive: true, force: true });
});

test("the baseline is the working tree, not HEAD, and the user's index is left alone", async () => {
  // Pre-task state with uncommitted work: an edit, a staged file, an untracked file, an ignored file.
  await fs.writeFile(path.join(repo, "app", "edited.txt"), "uncommitted edit\n");
  await fs.writeFile(path.join(repo, "app", "staged.txt"), "staged\n");
  await git("add", "app/staged.txt");
  await fs.writeFile(path.join(repo, "app", "untracked.txt"), "untracked\n");
  await fs.mkdir(path.join(repo, "ignored"));
  await fs.writeFile(path.join(repo, "ignored", "secret.txt"), "ignored\n");
  const statusBefore = await git("status", "--porcelain");

  const root = await repoRoot(repo);
  const baseline = await recordBaseline(root);

  assert.equal(await git("status", "--porcelain"), statusBefore, "snapshotting changed git status");
  assert.deepEqual(await readBaseline(root), baseline);
  const files = (await git("ls-tree", "-r", "--name-only", baseline.tree)).trim().split("\n");
  assert.deepEqual(files, [".gitignore", "app/committed.txt", "app/edited.txt", "app/staged.txt", "app/untracked.txt"]);
  assert.equal(await git("show", `${baseline.tree}:app/edited.txt`), "uncommitted edit\n");
});

test("changes after the baseline are reported relative to it, and trees materialize faithfully", async () => {
  const root = await repoRoot(repo);
  const baseline = await readBaseline(root);
  assert.ok(baseline);

  await fs.writeFile(path.join(repo, "app", "edited.txt"), "agent edit\n");
  await fs.rm(path.join(repo, "app", "committed.txt"));
  await fs.writeFile(path.join(repo, "app", "new.txt"), "new\n");

  const candidate = await snapshotWorkingTree(root);
  const from = await subtree(root, baseline.tree, "app");
  const to = await subtree(root, candidate, "app");
  assert.deepEqual(await changedFiles(root, from, to), [
    { status: "D", path: "committed.txt" },
    { status: "M", path: "edited.txt" },
    { status: "A", path: "new.txt" },
  ]);

  const out = path.join(repo, "ignored", "materialized");
  await materializeTree(root, from, out);
  assert.deepEqual((await fs.readdir(out)).sort(), ["committed.txt", "edited.txt", "staged.txt", "untracked.txt"]);
  assert.equal(await fs.readFile(path.join(out, "edited.txt"), "utf8"), "uncommitted edit\n");
});

test("a missing app directory is a clear error", async () => {
  const root = await repoRoot(repo);
  const baseline = await readBaseline(root);
  assert.ok(baseline);
  await assert.rejects(subtree(root, baseline.tree, "nope"), /Directory "nope" does not exist in snapshot/);
});
