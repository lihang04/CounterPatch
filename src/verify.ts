import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { EnvError, prepareEnv, startEnv, type RunningEnv } from "./env.ts";
import { diffEvidence, type Evidence, type EvidenceDifference } from "./evidence.ts";
import type { Probe } from "./probe.ts";
import { runProbe, type ProbeRun } from "./runner.ts";
import {
  changedFiles,
  readBaseline,
  repoRoot,
  snapshotWorkingTree,
  subtree,
  type Baseline,
  type ChangedFile,
} from "./snapshot.ts";

// What executing a probe on both sides established. Deciding whether a
// divergence is an intent violation or an intended change needs the user's
// intent, which is a later stage; this stage only reports what was observed.
export type Verdict =
  | "held" // passed on control and candidate
  | "diverged" // passed on control, failed on candidate: a counterexample
  | "discarded" // failed on control: the probe itself is wrong
  | "candidate-only-passed"
  | "candidate-only-failed"; // failed, with no baseline to validate the probe against

export type ProbeResult = {
  probe: Probe;
  verdict: Verdict;
  control: ProbeRun | null;
  candidate: ProbeRun | null;
  // Leaf-level evidence differences between the two sides (empty if one side did not run).
  differences: EvidenceDifference[];
};

export type Report =
  | { outcome: "unchanged"; baseline: Baseline }
  | { outcome: "environment-failed"; baseline: Baseline; changed: ChangedFile[]; failure: EnvFailure }
  | {
      outcome: "completed";
      baseline: Baseline;
      changed: ChangedFile[];
      results: ProbeResult[];
      runDir: string;
      reused: { control: boolean; candidate: boolean };
    };

export type EnvFailure = Pick<EnvError, "role" | "phase" | "message" | "logPath" | "logTail">;

export type Progress = (message: string) => void;

export function defaultHome(): string {
  return process.env.COUNTERPATCH_HOME ?? path.join(os.tmpdir(), "counterpatch");
}

// Compares what was observed, leaving out views derived from it
// (`network.last`, `db.*.rows`) so one change is reported once.
function observedDifferences(control: Evidence, candidate: Evidence): EvidenceDifference[] {
  const changes = (evidence: Evidence) =>
    Object.fromEntries(
      Object.entries(evidence.db).map(([name, observation]) => [
        name,
        "error" in observation ? observation : { added: observation.added, removed: observation.removed },
      ]),
    );
  return [
    ...diffEvidence(control.ui, candidate.ui, "ui"),
    ...diffEvidence(control.network.calls, candidate.network.calls, "network.calls"),
    ...diffEvidence(changes(control), changes(candidate), "db"),
  ];
}

function verdictFor(probe: Probe, control: ProbeRun | null, candidate: ProbeRun): Verdict {
  if (probe.candidateOnly || !control) {
    return candidate.status === "pass" ? "candidate-only-passed" : "candidate-only-failed";
  }
  if (control.status === "fail") return "discarded";
  return candidate.status === "pass" ? "held" : "diverged";
}

export async function verify(options: {
  repo: string;
  app: string;
  probes: Probe[];
  home?: string;
  progress?: Progress;
}): Promise<Report> {
  const progress = options.progress ?? (() => {});
  const root = await repoRoot(options.repo);
  const sourceAppDir = path.resolve(options.repo, options.app);
  if (!(await fs.stat(sourceAppDir).catch(() => null))?.isDirectory()) {
    throw new Error(`App directory ${sourceAppDir} does not exist. Pass --app <dir> relative to --repo.`);
  }
  const appPath = path.relative(await fs.realpath(root), await fs.realpath(sourceAppDir));
  if (appPath.startsWith("..")) throw new Error(`App directory ${sourceAppDir} is outside the repository ${root}.`);

  const baseline = await readBaseline(root);
  if (!baseline) {
    throw new Error('No baseline recorded. Run "counterpatch snapshot" before the coding task starts.');
  }

  const candidateTree = await snapshotWorkingTree(root);
  const controlAppTree = await subtree(root, baseline.tree, appPath);
  const candidateAppTree = await subtree(root, candidateTree, appPath);
  if (controlAppTree === candidateAppTree) return { outcome: "unchanged", baseline };
  const changed = await changedFiles(root, controlAppTree, candidateAppTree);

  await fs.mkdir(options.home ?? defaultHome(), { recursive: true });
  // Resolved so the app's bundler sees one canonical path (macOS /var -> /private/var).
  const home = await fs.realpath(options.home ?? defaultHome());
  const runId = `${new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "")}-${randomBytes(3).toString("hex")}`;
  const runDir = path.join(home, "runs", runId);
  await fs.mkdir(runDir, { recursive: true });

  const running: RunningEnv[] = [];
  try {
    progress("Preparing control (pre-task snapshot) and candidate (current working tree)…");
    const prepared = await Promise.all(
      (["control", "candidate"] as const).map((role) =>
        prepareEnv({
          role,
          repoRoot: root,
          tree: role === "control" ? controlAppTree : candidateAppTree,
          sourceAppDir,
          home,
        }),
      ),
    );
    const [controlPrepared, candidatePrepared] = prepared as [(typeof prepared)[0], (typeof prepared)[0]];

    progress("Starting both apps…");
    // Started one after the other so a failed start cannot leak the other server.
    const control = await startEnv(controlPrepared, runDir);
    running.push(control);
    const candidate = await startEnv(candidatePrepared, runDir);
    running.push(candidate);

    const browser = await chromium.launch();
    const results: ProbeResult[] = [];
    try {
      for (const [index, probe] of options.probes.entries()) {
        progress(`Probe ${index + 1}/${options.probes.length}: ${probe.title}`);
        const [controlRun, candidateRun] = await Promise.all([
          probe.candidateOnly ? null : runProbe(browser, control, probe, runDir),
          runProbe(browser, candidate, probe, runDir),
        ]);
        results.push({
          probe,
          verdict: verdictFor(probe, controlRun, candidateRun),
          control: controlRun,
          candidate: candidateRun,
          differences: controlRun ? observedDifferences(controlRun.evidence, candidateRun.evidence) : [],
        });
      }
    } finally {
      await browser.close();
    }

    const report: Report = {
      outcome: "completed",
      baseline,
      changed,
      results,
      runDir,
      reused: { control: controlPrepared.reused, candidate: candidatePrepared.reused },
    };
    await fs.writeFile(path.join(runDir, "report.json"), JSON.stringify(report, null, 2));
    return report;
  } catch (error) {
    if (error instanceof EnvError) {
      const { role, phase, message, logPath, logTail } = error;
      return { outcome: "environment-failed", baseline, changed, failure: { role, phase, message, logPath, logTail } };
    }
    throw error;
  } finally {
    await Promise.all(running.map((env) => env.stop()));
  }
}
