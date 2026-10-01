import type { ProbeRun } from "./runner.ts";
import type { ProbeResult, Report, Verdict } from "./verify.ts";

const MAX_DIFFERENCES = 8;

type Paint = (text: string) => string;

function palette(color: boolean) {
  const wrap =
    (code: number): Paint =>
    (text) =>
      color ? `\u001b[${code}m${text}\u001b[0m` : text;
  return { bold: wrap(1), dim: wrap(2), red: wrap(31), green: wrap(32), yellow: wrap(33) };
}

function show(value: unknown): string {
  if (value === undefined) return "(absent)";
  const text = JSON.stringify(value);
  return text.length > 90 ? `${text.slice(0, 87)}…` : text;
}

function count(results: ProbeResult[], verdict: Verdict): number {
  return results.filter((result) => result.verdict === verdict).length;
}

// Why a run failed, one reason per line.
function failureReasons(run: ProbeRun): string[] {
  const reasons: string[] = [];
  if (run.stepFailure) {
    const { index, step, message } = run.stepFailure;
    const target = "testId" in step ? step.testId : step.path;
    reasons.push(`step ${index + 1} (${step.do} ${target}): ${message}`);
    // Once the steps stop early, unmet expectations are consequences, not findings.
    const unmet = run.expectations.filter((result) => !result.ok).length;
    if (unmet > 0) reasons.push(`${unmet} of ${run.expectations.length} expectations unmet as a result`);
    return reasons;
  }
  for (const result of run.expectations) {
    if (!result.ok) reasons.push(result.expectation.description ? `${result.expectation.description} — ${result.message}` : result.message);
  }
  return reasons;
}

function summarize(run: ProbeRun): string {
  const added = Object.entries(run.evidence.db)
    .filter(([, observation]) => "added" in observation && observation.added.length > 0)
    .map(([name, observation]) => `${name} +${"added" in observation ? observation.added.length : 0}`);
  const calls = run.evidence.network.calls.map((call) => `${call.method} ${call.path} → ${call.status ?? "failed"}`);
  return [
    `ended on ${run.evidence.ui.url || "(no page)"}`,
    calls.length > 0 ? `network: ${calls.join(", ")}` : "network: no recorded calls",
    added.length > 0 ? `db: ${added.join(", ")}` : "db: no new rows",
  ].join("; ");
}

export function exitCode(report: Report): number {
  if (report.outcome === "unchanged") return 0;
  if (report.outcome === "environment-failed") return 2;
  const found = report.results.some((r) => r.verdict === "diverged" || r.verdict === "candidate-only-failed");
  return found ? 1 : 0;
}

export function renderReport(report: Report, color: boolean): string {
  const c = palette(color);
  const lines: string[] = ["", c.bold("COUNTERPATCH"), ""];

  if (report.outcome === "unchanged") {
    lines.push("The working tree is identical to the baseline snapshot. Nothing to verify.", "");
    return lines.join("\n");
  }

  lines.push(`Baseline recorded ${report.baseline.createdAt}; ${report.changed.length} file(s) changed since:`);
  for (const file of report.changed) lines.push(c.dim(`  ${file.status}  ${file.path}`));
  lines.push("");

  if (report.outcome === "environment-failed") {
    const { failure } = report;
    const meaning =
      failure.role === "control"
        ? "The pre-task snapshot itself does not run, so there is no baseline to compare against."
        : "The change left the app unable to run; no probes were executed.";
    lines.push(c.red(`${failure.role.toUpperCase()} FAILED DURING ${failure.phase.toUpperCase()}`), failure.message, meaning, "");
    if (failure.logTail) lines.push(c.dim(failure.logTail), "");
    lines.push(c.dim(`Full log: ${failure.logPath}`), "");
    return lines.join("\n");
  }

  const { results } = report;
  const diverged = count(results, "diverged");
  const discarded = count(results, "discarded");
  const unvalidated = count(results, "candidate-only-failed");
  const differential = results.filter((r) => !r.probe.candidateOnly).length;

  lines.push(
    `Probes run:              ${results.length}`,
    `Valid baseline probes:   ${differential - discarded}`,
    `Discarded probes:        ${discarded}`,
    `Candidate-only probes:   ${results.length - differential}`,
    "",
  );

  if (diverged + unvalidated === 0) {
    lines.push(c.green("No counterexample discovered."), "");
  } else {
    if (diverged > 0) lines.push(c.red(`${diverged} counterexample(s): passed before the change, fails after it.`));
    if (unvalidated > 0) lines.push(c.yellow(`${unvalidated} candidate-only failure(s): no baseline to validate the probe against.`));
    lines.push("");
  }

  for (const result of results.filter((r) => r.verdict === "diverged")) {
    const { probe, control, candidate, differences } = result;
    lines.push(c.red(c.bold(`✗ ${probe.title}`)) + c.dim(`  [${probe.id}]`));
    if (probe.description) lines.push(`  ${probe.description}`);
    if (control) lines.push(`  ${c.bold("BEFORE")}  passed — ${summarize(control)}`);
    if (candidate) {
      lines.push(`  ${c.bold("AFTER")}   failed — ${summarize(candidate)}`);
      for (const reason of failureReasons(candidate)) lines.push(`          ${reason}`);
    }
    if (differences.length > 0) {
      lines.push("  Observed differences (control → candidate):");
      for (const difference of differences.slice(0, MAX_DIFFERENCES)) {
        lines.push(`    ${difference.path}: ${show(difference.control)} → ${show(difference.candidate)}`);
      }
      if (differences.length > MAX_DIFFERENCES) lines.push(c.dim(`    … ${differences.length - MAX_DIFFERENCES} more in report.json`));
    }
    if (candidate?.screenshot) lines.push(c.dim(`  Screenshot: ${candidate.screenshot}`));
    lines.push("");
  }

  for (const result of results.filter((r) => r.verdict === "candidate-only-failed")) {
    const { probe, candidate } = result;
    lines.push(c.yellow(c.bold(`? ${probe.title}`)) + c.dim(`  [${probe.id}]`));
    if (probe.description) lines.push(`  ${probe.description}`);
    if (candidate) {
      lines.push(`  ${c.bold("AFTER")}   failed — ${summarize(candidate)}`);
      for (const reason of failureReasons(candidate)) lines.push(`          ${reason}`);
      if (candidate.screenshot) lines.push(c.dim(`  Screenshot: ${candidate.screenshot}`));
    }
    lines.push("");
  }

  const held = results.filter((r) => r.verdict === "held" || r.verdict === "candidate-only-passed");
  if (held.length > 0) {
    lines.push("Checked:");
    for (const result of held) {
      const suffix =
        result.verdict === "candidate-only-passed"
          ? c.dim("  (candidate only)")
          : result.differences.length > 0
            ? c.yellow(`  (passes, but ${result.differences.length} observed value(s) changed)`)
            : "";
      lines.push(`  ${c.green("✓")} ${result.probe.title}${suffix}`);
    }
    lines.push("");
  }

  const dropped = results.filter((r) => r.verdict === "discarded");
  if (dropped.length > 0) {
    lines.push("Discarded (failed against the pre-task snapshot, so the probe is wrong):");
    for (const result of dropped) {
      lines.push(`  ${c.dim("–")} ${result.probe.title}`);
      for (const reason of result.control ? failureReasons(result.control) : []) lines.push(c.dim(`      ${reason}`));
    }
    lines.push("");
  }

  lines.push(c.dim(`Evidence, screenshots and server logs: ${report.runDir}`), "");
  return lines.join("\n");
}
