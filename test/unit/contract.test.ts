import assert from "node:assert/strict";
import { test } from "node:test";
import { assessContract, parseContract, validateContractProbes } from "../../src/contract.ts";
import { renderHtmlReport } from "../../src/html-report.ts";
import { parseProbe } from "../../src/probe.ts";
import { exitCode, renderReport } from "../../src/report.ts";
import type { ProbeRun } from "../../src/runner.ts";
import type { RunReport } from "../../src/verify.ts";
import { evaluateContractCorpus } from "../contract-corpus.ts";

const requirement = { id: "checkout", kind: "preserve", description: "Guest checkout stays available" };
const contract = parseContract({ schemaVersion: 1, title: "Checkout task", requirements: [requirement] });
const probe = parseProbe({ id: "guest", title: "Guest checkout", requirementId: "checkout",
  steps: [{ do: "goto", path: "/checkout" }], expect: [{ path: "ui.url", equals: "/checkout" }] }, "test");
const run = (status: "pass" | "fail"): ProbeRun => ({ status, stepFailure: null, expectations: [], screenshot: null, durationMs: 1,
  evidence: { ui: { url: status === "pass" ? "/checkout" : "/login", captures: {} }, network: { calls: [], last: {} }, db: {} } });

test("labeled cases distinguish requested changes, regressions, existing failures and harmless changes", async () => {
  const cases = await evaluateContractCorpus();
  assert.equal(cases.length, 10);
  for (const entry of cases) {
    assert.equal(entry.actual, entry.expected, entry.id);
    assert.equal(entry.actualDecision, entry.expectedDecision, entry.id);
  }
});

test("contracts reject ambiguous requirements and invalid probe associations", () => {
  assert.throws(() => parseContract({ ...contract, schemaVersion: 2 }), /invalid/);
  assert.throws(() => parseContract({ ...contract, requirements: [requirement, requirement] }), /duplicate requirement/);
  assert.throws(() => parseContract({ ...contract, requirements: [] }), /invalid/);
  assert.throws(() => validateContractProbes(contract, [{ ...probe, requirementId: "unknown" }]), /requirementId/);
  assert.throws(() => validateContractProbes(contract, [{ ...probe, requirementId: undefined }]), /requirementId/);
  assert.throws(() => validateContractProbes(contract, [{ ...probe, candidateOnly: true }]), /both snapshots/);
  assert.throws(() => validateContractProbes(undefined, [probe]), /supply --contract/);
  assert.throws(() => validateContractProbes(contract, [probe, probe]), /Duplicate probe/);
});

test("a passing probe cannot hide uncovered requirements or failed sibling probes", () => {
  const withExtra = parseContract({ ...contract, requirements: [requirement, { ...requirement, id: "totals" }] });
  assert.equal(assessContract(withExtra, [{ probe, control: run("pass"), candidate: run("pass") }]).status, "inconclusive");
  assert.equal(assessContract(contract, []).status, "inconclusive");
  assert.equal(assessContract(withExtra, [
    { probe, control: run("pass"), candidate: run("pass") },
    { probe: { ...probe, id: "another" }, control: run("pass"), candidate: run("fail") },
  ]).status, "unmet");
});

test("missing execution or failed observables remain inconclusive", () => {
  const broken = run("fail");
  broken.evidence.db.orders = { error: "no such table: orders" };
  for (const candidate of [null, broken]) {
    const assessment = assessContract(contract, [{ probe, control: run("pass"), candidate }]);
    assert.equal(assessment.status, "inconclusive");
  }
});

test("contract decisions drive exit codes and reports without calling baseline failures invalid probes", () => {
  const change = parseContract({ ...contract, title: "<script>task</script>", requirements: [{ ...requirement, kind: "change" }], exclusions: ["<img src=x>"] });
  const results = [{ probe, verdict: "discarded" as const, control: run("fail"), candidate: run("pass"), differences: [] }];
  const assessment = assessContract(change, results);
  const report: RunReport = { outcome: "completed", assessment, results, runDir: "/tmp/run", changed: [], reused: { control: true, candidate: true },
    baseline: { commit: "commit", tree: "tree", createdAt: "2026-01-01" } };
  assert.equal(exitCode(report), 0);
  const text = renderReport(report, false);
  assert.match(text, /fulfilled/);
  assert.doesNotMatch(text, /probe is wrong|counterexample\(s\)/);
  const html = renderHtmlReport(report, new Map());
  assert.match(html, /Task requirements met by the checked probes/);
  assert.match(html, /&lt;script&gt;task&lt;\/script&gt;/);
  assert.match(html, /&lt;img src=x&gt;/);
  assert.doesNotMatch(html, /<script>task|probe is wrong/);
  assert.equal(exitCode({ ...report, assessment: assessContract(contract, []) }), 3);
  const unmet = assessContract(contract, [{ probe, control: run("pass"), candidate: run("fail") }]);
  assert.equal(exitCode({ ...report, assessment: unmet }), 1);
});
