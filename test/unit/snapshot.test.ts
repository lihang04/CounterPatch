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

test("trees can be materialized concurrently, as control and candidate are", async (t) => {
  // A frozen clock reproduces two calls landing in the same millisecond.
  t.mock.method(Date, "now", () => 1_790_000_000_000);
  const root = await repoRoot(repo);
  const baseline = await readBaseline(root);
  assert.ok(baseline);
  const candidate = await snapshotWorkingTree(root);
  const out = path.join(repo, "ignored", "concurrent");

  // Each call needs its own scratch index; sharing one makes git fail on its
  // lock or check out the other call's tree.
  for (let round = 0; round < 10; round++) {
    const a = path.join(out, `${round}-a`);
    const b = path.join(out, `${round}-b`);
    await Promise.all([materializeTree(root, baseline.tree, a), materializeTree(root, candidate, b)]);
    assert.equal(await fs.readFile(path.join(a, "app", "edited.txt"), "utf8"), "uncommitted edit\n");
    assert.equal(await fs.readFile(path.join(b, "app", "edited.txt"), "utf8"), "agent edit\n");
  }
});

test("force-added ignored files are captured from disk, with and without HEAD", async (t) => {
  for (const committed of [false, true]) {
    await t.test(committed ? "committed repository" : "unborn repository", async (t) => {
      const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "counterpatch-forced-")));
      t.after(() => fs.rm(dir, { recursive: true, force: true }));
      const git = async (...args: string[]) => (await exec("git", args, { cwd: dir })).stdout;
      await git("init", "--quiet");
      await fs.writeFile(path.join(dir, ".gitignore"), "ignored/\n");
      await git("add", ".gitignore");
      if (committed) await git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "--quiet", "-m", "initial");
      await fs.mkdir(path.join(dir, "ignored"));
      const names = ["ignored/forced.txt", "ignored/with\ttab\nand newline.txt", "ignored/deleted.txt"];
      for (const name of names) await fs.writeFile(path.join(dir, name), "staged contents\n");
      await git("add", "-f", "--", ...names);
      for (const name of names.slice(0, 2)) await fs.writeFile(path.join(dir, name), "current disk contents\n");
      await fs.rm(path.join(dir, names[2]!));
      await fs.writeFile(path.join(dir, "ignored", "untracked.txt"), "excluded\n");
      const index = path.join(dir, ".git", "index");
      const before = await fs.readFile(index);

      const tree = await snapshotWorkingTree(dir);
      assert.deepEqual(await fs.readFile(index), before, "the real index changed");
      for (const name of names.slice(0, 2)) assert.equal(await git("show", `${tree}:${name}`), "current disk contents\n");
      const files = (await git("ls-tree", "-r", "-z", "--name-only", tree)).split("\0").filter(Boolean);
      assert.deepEqual(files, [".gitignore", ...names.slice(0, 2)]);
    });
  }
});

test("snapshotting does not inherit assume-unchanged flags from the real index", async () => {
  await git("update-index", "--assume-unchanged", "app/edited.txt");
  const index = path.join(repo, ".git", "index");
  const before = await fs.readFile(index);
  try {
    await fs.writeFile(path.join(repo, "app", "edited.txt"), "changed despite the index flag\n");
    const tree = await snapshotWorkingTree(repo);
    assert.equal(await git("show", `${tree}:app/edited.txt`), "changed despite the index flag\n");
    assert.deepEqual(await fs.readFile(index), before);
  } finally {
    await git("update-index", "--no-assume-unchanged", "app/edited.txt");
  }
});
