import fs from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { killAllServers } from "./env.ts";
import { onPrompt, onStop, readTask, readTaskPrompts } from "./hooks.ts";
import { loadProbes } from "./probe.ts";
import { exitCode, renderReport } from "./report.ts";
import { changedFiles, readBaseline, recordBaseline, repoRoot, snapshotWorkingTree } from "./snapshot.ts";
import { defaultHome, verify } from "./verify.ts";

const USAGE = `Usage: counterpatch <command> [options]

Commands:
  snapshot   Record the current working tree as the pre-task baseline.
  status     Show the baseline and what has changed since it was recorded.
  verify     Run probes against the baseline (control) and the current
             working tree (candidate) and report where they diverge.
  clean      Delete cached environments and past run artifacts.
  hook prompt   Coding-agent hook for a submitted user prompt: logs the prompt
                and records the baseline on the first prompt of a task.
  hook stop     Coding-agent hook for the agent finishing: verifies the task
                and shows the report. Takes --app and --probes like verify.

Options:
  --repo <dir>      Git repository to operate on (default: current directory;
                    for hooks, the session's project directory).
  --app <dir>       App directory inside the repository, containing
                    counterpatch.manifest.json (default: the repository root).
  --probes <path>   Probe file or directory of *.json probes. Repeatable.
  --json            verify: print the full report as JSON instead of text.

Exit codes for verify: 0 no counterexample discovered, 1 counterexample found,
2 an environment failed to install, build or start.

Hook commands read the hook's JSON input on stdin and always exit 0.
`;

type HookOptions = { repo?: string; app: string; probes: string[] };

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) throw new Error("Hook commands read the hook's JSON input on stdin.");
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  return text;
}

// The one channel a hook uses to reach the user. Plain stdout from a prompt
// hook would be added to the agent's context, which must not happen.
function tellUser(message: string): void {
  process.stdout.write(`${JSON.stringify({ systemMessage: message })}\n`);
}

// Never exits 2: Claude Code treats that as "block", which would discard the
// user's prompt or stop the agent from finishing.
async function runHook(event: string | undefined, options: HookOptions): Promise<number> {
  try {
    let input: { cwd?: unknown };
    try {
      input = JSON.parse(await readStdin());
    } catch (error) {
      throw new Error(`Hook input is not valid JSON: ${(error as Error).message}`);
    }
    const sessionDir = typeof input?.cwd === "string" ? input.cwd : process.cwd();
    const root = await repoRoot(path.resolve(options.repo ?? process.env.CLAUDE_PROJECT_DIR ?? sessionDir));

    if (event === "prompt") {
      await onPrompt(root, input);
      return 0;
    }
    if (event === "stop") {
      if (options.probes.length === 0) throw new Error("hook stop needs at least one --probes <file-or-directory>.");
      const { message } = await onStop(root, input, async () =>
        verify({
          repo: root,
          app: options.app,
          probes: await loadProbes(options.probes.map((source) => path.resolve(root, source))),
        }),
      );
      if (message) tellUser(message);
      return 0;
    }
    throw new Error(`Unknown hook "${event ?? ""}". Use "hook prompt" or "hook stop".`);
  } catch (error) {
    killAllServers();
    tellUser(`CounterPatch ${event ?? ""} hook failed: ${(error as Error).message}`);
    return 0;
  }
}

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      repo: { type: "string" },
      app: { type: "string", default: "." },
      probes: { type: "string", multiple: true, default: [] },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  const command = positionals[0];
  if (values.help || !command) {
    process.stdout.write(USAGE);
    return command || values.help ? 0 : 64;
  }
  if (command === "hook") return runHook(positionals[1], values);
  const repo = path.resolve(values.repo ?? process.cwd());

  switch (command) {
    case "snapshot": {
      const root = await repoRoot(repo);
      const previous = await readBaseline(root);
      const baseline = await recordBaseline(root);
      console.log(`Baseline recorded: tree ${baseline.tree.slice(0, 12)} at ${baseline.createdAt}`);
      if (previous) console.log(`Replaced the baseline recorded at ${previous.createdAt}.`);
      return 0;
    }
    case "status": {
      const root = await repoRoot(repo);
      const baseline = await readBaseline(root);
      if (!baseline) {
        console.log('No baseline recorded. Run "counterpatch snapshot" before the coding task starts.');
        return 0;
      }
      const task = await readTask(root);
      if (task) {
        const prompts = await readTaskPrompts(root);
        console.log(`Open task: session ${task.sessionId}, started ${task.startedAt}, ${prompts.length} prompt(s) captured`);
      }
      const changed = await changedFiles(root, baseline.tree, await snapshotWorkingTree(root));
      console.log(`Baseline: tree ${baseline.tree.slice(0, 12)} recorded ${baseline.createdAt}`);
      console.log(changed.length === 0 ? "No changes since the baseline." : `${changed.length} file(s) changed since:`);
      for (const file of changed) console.log(`  ${file.status}  ${file.path}`);
      return 0;
    }
    case "verify": {
      if (values.probes.length === 0) throw new Error("verify needs at least one --probes <file-or-directory>.");
      const probes = await loadProbes(values.probes.map((source) => path.resolve(source)));
      const report = await verify({
        repo,
        app: values.app,
        probes,
        progress: (message) => process.stderr.write(`${message}\n`),
      });
      process.stdout.write(
        values.json ? `${JSON.stringify(report, null, 2)}\n` : renderReport(report, process.stdout.isTTY === true),
      );
      return exitCode(report);
    }
    case "clean": {
      // Only CounterPatch's own subdirectories, in case the home was pointed at a shared directory.
      for (const name of ["envs", "runs"]) {
        const dir = path.join(defaultHome(), name);
        await fs.rm(dir, { recursive: true, force: true });
        console.log(`Removed ${dir}`);
      }
      return 0;
    }
    default:
      throw new Error(`Unknown command "${command}".\n\n${USAGE}`);
  }
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    killAllServers();
    process.exit(signal === "SIGINT" ? 130 : 143);
  });
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: Error) => {
    killAllServers();
    process.stderr.write(`counterpatch: ${error.message}\n`);
    process.exitCode = 2;
  },
);
