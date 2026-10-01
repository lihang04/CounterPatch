import fs from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { killAllServers } from "./env.ts";
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

Options:
  --repo <dir>      Git repository to operate on (default: current directory).
  --app <dir>       App directory inside the repository, containing
                    counterpatch.manifest.json (default: the repository root).
  --probes <path>   Probe file or directory of *.json probes. Repeatable.
  --json            verify: print the full report as JSON instead of text.

Exit codes for verify: 0 no counterexample discovered, 1 counterexample found,
2 an environment failed to install, build or start.
`;

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      repo: { type: "string", default: process.cwd() },
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
  const repo = path.resolve(values.repo);

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
