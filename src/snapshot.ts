import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { exec } from "./exec.ts";

export const BASELINE_REF = "refs/counterpatch/baseline";

export type Baseline = { commit: string; tree: string; createdAt: string };

export type ChangedFile = { status: string; path: string };

const IDENTITY = {
  GIT_AUTHOR_NAME: "CounterPatch",
  GIT_AUTHOR_EMAIL: "counterpatch@localhost",
  GIT_COMMITTER_NAME: "CounterPatch",
  GIT_COMMITTER_EMAIL: "counterpatch@localhost",
};

async function git(cwd: string, args: string[], env: NodeJS.ProcessEnv = {}): Promise<string> {
  const { stdout } = await exec("git", args, { cwd, env: { ...process.env, ...env } });
  return stdout.trim();
}

export async function repoRoot(dir: string): Promise<string> {
  try {
    return await git(dir, ["rev-parse", "--show-toplevel"]);
  } catch {
    throw new Error(`${dir} is not inside a git repository. CounterPatch snapshots need one (run "git init").`);
  }
}

// Where CounterPatch keeps per-repository state. Inside the git directory, so
// it is never part of the working tree, a snapshot, or a commit.
export async function stateDir(root: string): Promise<string> {
  return path.join(await git(root, ["rev-parse", "--absolute-git-dir"]), "counterpatch");
}

// Runs `fn` with a private index file so the user's real index is never touched.
async function withScratchIndex<T>(root: string, fn: (env: NodeJS.ProcessEnv) => Promise<T>): Promise<T> {
  const gitDir = await git(root, ["rev-parse", "--absolute-git-dir"]);
  // Random, not clock-based: control and candidate are materialized in parallel.
  const scratch = path.join(gitDir, `counterpatch-index-${randomUUID()}`);
  try {
    return await fn({ GIT_INDEX_FILE: scratch });
  } finally {
    await fs.rm(scratch, { force: true });
    await fs.rm(`${scratch}.lock`, { force: true });
  }
}

// Captures the working tree exactly as it is on disk — tracked, modified and
// untracked files, minus ignored files that are not tracked — and returns its tree id.
// Comparing against HEAD instead would miss uncommitted pre-task changes.
export async function snapshotWorkingTree(root: string): Promise<string> {
  return withScratchIndex(root, async (env) => {
    const hasHead = await git(root, ["rev-parse", "--verify", "--quiet", "HEAD"]).then(
      () => true,
      () => false,
    );
    // Starting from HEAD lets `add` reuse existing blobs for unchanged files.
    if (hasHead) await git(root, ["read-tree", "HEAD"], env);
    // Include newly staged files even when they match .gitignore. Transfer
    // entries without index flags so assume-unchanged/skip-worktree cannot
    // hide edits on disk. NUL records preserve arbitrary filenames.
    const { stdout: entries } = await exec("git", ["ls-files", "--stage", "-z"], { cwd: root });
    if (entries) {
      await exec("git", ["update-index", "-z", "--index-info"], {
        cwd: root,
        env: { ...process.env, ...env },
        input: entries,
      });
    }
    await git(root, ["add", "--all", "--", "."], env);
    return git(root, ["write-tree"], env);
  });
}

export async function recordBaseline(root: string): Promise<Baseline> {
  const tree = await snapshotWorkingTree(root);
  const commit = await git(root, ["commit-tree", tree, "-m", "counterpatch baseline"], IDENTITY);
  await git(root, ["update-ref", BASELINE_REF, commit]);
  const baseline = await readBaseline(root);
  if (!baseline) throw new Error(`Could not read back ${BASELINE_REF} after writing it.`);
  return baseline;
}

export async function readBaseline(root: string): Promise<Baseline | null> {
  let line: string;
  try {
    line = await git(root, ["show", "--no-patch", "--format=%H %T %cI", BASELINE_REF]);
  } catch {
    return null;
  }
  const [commit, tree, committedAt] = line.split(" ");
  if (!commit || !tree || !committedAt) throw new Error(`Unexpected baseline ref contents: ${line}`);
  return { commit, tree, createdAt: new Date(committedAt).toISOString() };
}

// Tree id of `appPath` inside `tree` ("" means the repository root).
export async function subtree(root: string, tree: string, appPath: string): Promise<string> {
  if (appPath === "") return tree;
  try {
    return await git(root, ["rev-parse", "--verify", "--quiet", `${tree}:${appPath}`]);
  } catch {
    throw new Error(`Directory "${appPath}" does not exist in snapshot ${tree.slice(0, 10)}.`);
  }
}

export async function changedFiles(root: string, fromTree: string, toTree: string): Promise<ChangedFile[]> {
  const output = await git(root, ["diff-tree", "-r", "--name-status", "--no-renames", fromTree, toTree]);
  if (!output) return [];
  return output.split("\n").map((line) => {
    const [status = "", ...rest] = line.split("\t");
    return { status, path: rest.join("\t") };
  });
}

export async function materializeTree(root: string, tree: string, dest: string): Promise<void> {
  await fs.mkdir(dest, { recursive: true });
  await withScratchIndex(root, async (env) => {
    await git(root, ["read-tree", tree], env);
    await git(root, ["checkout-index", "--all", `--prefix=${dest}${path.sep}`], env);
  });
}
