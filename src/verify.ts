import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { executionIdentity, loadVerificationBundle, validateBundleRepository, writeVerificationBundle, type BundleReference, type ReplayInfo } from "./bundle.ts";
import { assessContract, parseContract, validateContractProbes, type ContractAssessment, type TaskContract } from "./contract.ts";
import { EnvError, prepareEnv, startEnv, type RunningEnv } from "./env.ts";
import { diffEvidence, type Evidence, type EvidenceDifference } from "./evidence.ts";
import { writeHtmlReport } from "./html-report.ts";
import { parseProbe, type Probe } from "./probe.ts";
import { registerOperation } from "./process.ts";
import { PROBE_LIMITS, runProbe, type ProbeLimits, type ProbeRun } from "./runner.ts";
import {
  changedFiles,
  readBaseline,
  repoRoot,
  snapshotWorkingTree,
  subtree,
  type Baseline,
  type ChangedFile,
} from "./snapshot.ts";

// Legacy differential labels remain available in reports. When a task
// contract is supplied, its assessment determines the task's outcome.
export type Verdict =
  | "held" // passed on control and candidate
  | "diverged" // passed on control, failed on candidate: a counterexample
  | "discarded" // failed on control: preservation cannot be established
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

export type RunReport = {
  baseline: Baseline;
  changed: ChangedFile[];
  results: ProbeResult[];
  runDir: string;
  reused: { control: boolean; candidate: boolean };
  assessment?: ContractAssessment;
  bundle?: BundleReference;
  replay?: ReplayInfo;
} & ({ outcome: "completed" } | { outcome: "inconclusive" });

export type Report =
  | { outcome: "unchanged"; baseline: Baseline }
  | { outcome: "environment-failed"; baseline: Baseline; changed: ChangedFile[]; failure: EnvFailure; runDir?: string; bundle?: BundleReference; replay?: ReplayInfo }
  | RunReport;

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

// Cancel sibling work on the first failure, then await its cleanup before
// returning a report or closing the browser it may still be using.
async function together<T extends readonly unknown[]>(tasks: T, controller: AbortController) {
  let failure: { error: unknown } | undefined;
  const settled = await Promise.allSettled(tasks.map((task) => Promise.resolve(task).catch((error: unknown) => {
    if (!failure) {
      failure = { error };
      controller.abort();
    }
    throw error;
  })));
  if (failure) throw failure.error;
  return settled.map((result) => (result as PromiseFulfilledResult<unknown>).value) as {
    -readonly [K in keyof T]: Awaited<T[K]>;
  };
}

export async function verify(options: {
  repo: string;
  app: string;
  probes: Probe[];
  home?: string;
  progress?: Progress;
  signal?: AbortSignal;
  contract?: TaskContract;
}): Promise<Report> {
  options.signal?.throwIfAborted();
  const contract = options.contract ? parseContract(options.contract) : undefined;
  const probes = options.probes.map((probe) => parseProbe(probe, "verification"));
  validateContractProbes(contract, probes);
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
  // An unchanged app can still leave a requested behavior unimplemented.
  if (controlAppTree === candidateAppTree && !contract) return { outcome: "unchanged", baseline };
  return executeSnapshots({ ...options, root, appPath, baseline, candidateTree, controlAppTree, candidateAppTree, contract, probes });
}

export async function replay(options: {
  bundle: string; repo?: string; home?: string; signal?: AbortSignal; progress?: Progress;
}): Promise<Report> {
  options.signal?.throwIfAborted();
  const sourcePath = await fs.realpath(options.bundle);
  const bundle = await loadVerificationBundle(sourcePath);
  const root = await validateBundleRepository(bundle, options.repo);
  const current = await executionIdentity(bundle.execution.probeLimits);
  const executionDrift: ReplayInfo["executionDrift"] = [];
  for (const field of ["nodeVersion", "platform", "architecture", "verifierSourceHash", "dependencyLockHash"] as const) {
    if (current[field] !== bundle.execution[field]) executionDrift.push({ field, recorded: bundle.execution[field], current: current[field] });
  }
  const replayInfo: ReplayInfo = { sourceBundle: { path: sourcePath, sha256: bundle.sha256 }, executionDrift };
  return executeSnapshots({ ...options, root, appPath: bundle.appPath, baseline: bundle.snapshots.baseline,
    candidateTree: bundle.snapshots.candidateTree, controlAppTree: bundle.snapshots.controlAppTree,
    candidateAppTree: bundle.snapshots.candidateAppTree, probes: bundle.probes, contract: bundle.contract ?? undefined,
    probeLimits: bundle.execution.probeLimits, replay: replayInfo, fresh: true });
}

async function executeSnapshots(options: {
  root: string; appPath: string; baseline: Baseline; candidateTree: string; controlAppTree: string; candidateAppTree: string;
  probes: Probe[]; contract?: TaskContract; home?: string; signal?: AbortSignal; progress?: Progress;
  probeLimits?: ProbeLimits; replay?: ReplayInfo; fresh?: boolean;
}): Promise<Report> {
  const { root, appPath, baseline, candidateTree, controlAppTree, candidateAppTree, probes, contract } = options;
  const progress = options.progress ?? (() => {});
  const probeLimits = options.probeLimits ?? PROBE_LIMITS;
  options.signal?.throwIfAborted();
  const changed = await changedFiles(root, controlAppTree, candidateAppTree);

  await fs.mkdir(options.home ?? defaultHome(), { recursive: true });
  // Resolved so the app's bundler sees one canonical path (macOS /var -> /private/var).
  const home = await fs.realpath(options.home ?? defaultHome());
  const runId = `${new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "")}-${randomBytes(3).toString("hex")}`;
  const runDir = path.join(home, "runs", runId);
  await fs.mkdir(runDir, { recursive: true });
  const bundle = await writeVerificationBundle({ root, appPath, baseline, candidateTree,
    controlAppTree, candidateAppTree, runDir, probes, contract, probeLimits,
    fresh: options.fresh, replayOf: options.replay?.sourceBundle });
  const preparationHome = options.fresh ? path.join(runDir, "environment-cache") : home;

  const running: RunningEnv[] = [];
  const controller = new AbortController();
  const unregister = registerOperation(controller);
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  try {
    signal.throwIfAborted();
    progress(options.replay ? "Replaying retained control and candidate snapshots in fresh environments…"
      : "Preparing control (pre-task snapshot) and candidate (current working tree)…");
    const prepared = await together(
      (["control", "candidate"] as const).map((role) =>
        prepareEnv({
          role,
          repoRoot: root,
          tree: role === "control" ? controlAppTree : candidateAppTree,
          home: preparationHome,
          signal,
        }),
      ), controller,
    );
    const [controlPrepared, candidatePrepared] = prepared as [(typeof prepared)[0], (typeof prepared)[0]];

    progress("Starting both apps…");
    // Started one after the other so a failed start cannot leak the other server.
    const control = await startEnv(controlPrepared, runDir, signal);
    running.push(control);
    const candidate = await startEnv(candidatePrepared, runDir, signal);
    running.push(candidate);

    const browser = await chromium.launch();
    const results: ProbeResult[] = [];
    try {
      for (const [index, probe] of probes.entries()) {
        signal.throwIfAborted();
        progress(`Probe ${index + 1}/${probes.length}: ${probe.title}`);
        const [controlRun, candidateRun] = await together([
          probe.candidateOnly ? null : runProbe(browser, control, probe, runDir, probeLimits),
          runProbe(browser, candidate, probe, runDir, probeLimits),
        ] as const, controller);
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

    signal.throwIfAborted();
    const assessment = contract ? assessContract(contract, results) : undefined;
    const report: RunReport = {
      // Discarded probes establish nothing about the change. An empty run
      // through the programmatic API is likewise inconclusive.
      outcome: (assessment ? assessment.status === "inconclusive" : results.every((result) => result.verdict === "discarded")) ? "inconclusive" : "completed",
      baseline,
      changed,
      results,
      runDir,
      reused: { control: controlPrepared.reused, candidate: candidatePrepared.reused },
      assessment,
      bundle,
      replay: options.replay,
    };
    await fs.writeFile(path.join(runDir, "report.json"), JSON.stringify(report, null, 2));
    await writeHtmlReport(report);
    return report;
  } catch (error) {
    if (error instanceof EnvError) {
      const { role, phase, message, logPath, logTail } = error;
      const report: Report = { outcome: "environment-failed", baseline, changed, runDir, bundle, replay: options.replay,
        failure: { role, phase, message, logPath, logTail } };
      await fs.writeFile(path.join(runDir, "report.json"), JSON.stringify(report, null, 2));
      return report;
    }
    throw error;
  } finally {
    try { await Promise.all(running.map((env) => env.stop())); } finally { unregister(); }
  }
}
