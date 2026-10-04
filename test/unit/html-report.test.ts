import assert from "node:assert/strict";
import { test } from "node:test";
import { groupBySymptom, renderHtmlReport } from "../../src/html-report.ts";
import { parseProbe } from "../../src/probe.ts";
import { exitCode, renderReport } from "../../src/report.ts";
import type { ProbeRun } from "../../src/runner.ts";
import type { ProbeResult, Report, Verdict } from "../../src/verify.ts";

type Completed = Extract<Report, { outcome: "completed" }>;

function run(status: "pass" | "fail", url: string, screenshot: string | null = null): ProbeRun {
  return {
    status,
    stepFailure: null,
    expectations: [],
    evidence: { ui: { url, captures: {} }, network: { calls: [], last: {} }, db: {} },
    screenshot,
    durationMs: 1,
  };
}

function result(id: string, verdict: Verdict, before: string | null, after: string, differences: ProbeResult["differences"] = []): ProbeResult {
  const probe = parseProbe(
    { id, title: `Title of ${id}`, candidateOnly: before === null, steps: [{ do: "goto", path: "/" }], expect: [{ path: "ui.url", equals: "/" }] },
    "inline",
  );
  const failed = verdict === "diverged" || verdict === "candidate-only-failed";
  return {
    probe,
    verdict,
    control: before === null ? null : run(verdict === "discarded" ? "fail" : "pass", before, `/shots/${id}.control.png`),
    candidate: run(failed ? "fail" : "pass", after, `/shots/${id}.candidate.png`),
    differences,
  };
}

function report(results: ProbeResult[]): Completed {
  return {
    outcome: "completed",
    baseline: { commit: "c", tree: "t", createdAt: "2026-10-02T16:55:19.000Z" },
    changed: [{ status: "M", path: "app/checkout/page.tsx" }],
    results,
    runDir: "/tmp/run",
    reused: { control: false, candidate: false },
  };
}

const urlChange = (before: string, after: string) => ({ path: "ui.url", control: before, candidate: after });

test("counterexamples that land on the same unexpected page are one symptom", () => {
  const groups = groupBySymptom([
    result("a", "diverged", "/checkout", "/login", [urlChange("/checkout", "/login")]),
    result("b", "diverged", "/order/1", "/login", [urlChange("/order/1", "/login"), { path: "db.orders.added[0]", control: { id: 1 }, candidate: undefined }]),
    result("c", "diverged", "/cart", "/cart"),
  ]);
  assert.deepEqual(
    groups.map((group) => [group.endedOn, group.results.map((r) => r.probe.id)]),
    [
      ["/login", ["b", "a"]], // the probe that observed the most change leads
      [null, ["c"]],
    ],
  );
});

test("the page states what was found, groups it, and embeds the screenshots", () => {
  const html = renderHtmlReport(
    report([
      result("a", "diverged", "/checkout", "/login", [urlChange("/checkout", "/login")]),
      result("b", "diverged", "/order/1", "/login", [urlChange("/order/1", "/login")]),
      result("new", "candidate-only-failed", null, "/login"),
      result("ok", "held", "/cart", "/cart"),
      result("wrong", "discarded", "/", "/"),
    ]),
    new Map([["/shots/a.candidate.png", "QUJD"]]),
  );
  assert.match(html, /<h1>2 probes passed before the change and fail after it\.<\/h1>/);
  assert.match(html, /They show 1 distinct symptom\. 1 more probe failed with no baseline to compare against\./);
  assert.match(html, /2 probes now end on <code>\/login<\/code>/);
  assert.match(html, /1 more probe with the same symptom/);
  assert.match(html, /Stopped on <code>\/login<\/code>, the same page as the counterexamples above\./);
  assert.match(html, /src="data:image\/png;base64,QUJD"/);
  assert.match(html, /No screenshot was captured\./);
  assert.match(html, /<summary>Checked <span class="count">1 probe passed<\/span>/);
  assert.match(html, /<summary>Unverified preservation <span class="count">1 probe failed/);
  assert.doesNotMatch(html, /probe is wrong/);
});

test("a clean run says no counterexample was discovered, never that the change is safe", () => {
  const html = renderHtmlReport(report([result("ok", "held", "/cart", "/cart")]), new Map());
  assert.match(html, /<h1>No counterexample discovered\.<\/h1>/);
  assert.match(html, /This is not a statement that the change is safe\./);
  assert.match(html, /<details open>\s*<summary>Checked/);
  assert.doesNotMatch(html, /<h2>Counterexamples<\/h2>/);
});

test("content from the app and from probes is escaped", () => {
  const hostile = result("x", "diverged", "/a", '/b"><script>alert(1)</script>', [
    { path: "network.calls[0]", control: { method: "POST", path: "/api/x", status: 200, requestBody: null, responseBody: { note: "</pre><img src=x onerror=alert(2)>" } }, candidate: undefined },
  ]);
  hostile.probe.title = "<script>alert(3)</script>";
  const html = renderHtmlReport(report([hostile]), new Map());
  assert.doesNotMatch(html, /<script>alert/);
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&lt;script&gt;alert\(3\)&lt;\/script&gt;/);
  assert.match(html, /&lt;\/pre&gt;&lt;img src=x onerror=alert\(2\)&gt;/);
});

test("an inconclusive run shows a warning and the discarded probes instead of success", () => {
  const inconclusive: Report = {
    ...report([result("wrong", "discarded", "/", "/")]),
    outcome: "inconclusive",
  };
  assert.equal(exitCode(inconclusive), 3);
  const text = renderReport(inconclusive, false);
  assert.match(text, /Verification inconclusive/);
  assert.match(text, /Repair or add probes/);
  assert.match(text, /Valid baseline probes: +0/);
  assert.match(text, /Title of wrong/);
  assert.match(text, /Report page: .*report\.html/);
  assert.doesNotMatch(text, /No counterexample discovered/);

  const html = renderHtmlReport(inconclusive, new Map());
  assert.match(html, /<section class="verdict tone-warn">/);
  assert.match(html, /<h1>Verification inconclusive\.<\/h1>/);
  assert.match(html, /<details open>\s*<summary>Unverified preservation/);
  assert.match(html, /Repair or add probes/);
  assert.doesNotMatch(html, /No counterexample discovered/);
});

test("discarded probes do not mask usable results or change candidate-only exit codes", () => {
  for (const [verdict, code] of [
    ["held", 0], ["diverged", 1], ["candidate-only-passed", 0], ["candidate-only-failed", 1],
  ] as const) {
    const before = verdict.startsWith("candidate-only") ? null : "/";
    const mixed = report([result("wrong", "discarded", "/", "/"), result("usable", verdict, before, "/")]);
    assert.equal(exitCode(mixed), code, verdict);
    assert.doesNotMatch(renderReport(mixed, false), /Verification inconclusive/);
    assert.doesNotMatch(renderHtmlReport(mixed, new Map()), /Verification inconclusive/);
  }
});

test("replay reports link their source and explain execution differences with escaped paths", () => {
  const replayed = { ...report([result("ok", "held", "/cart", "/cart")]), replay: {
    sourceBundle: { path: '/tmp/<script>source</script>/bundle.json', sha256: "a".repeat(64) },
    executionDrift: [{ field: "nodeVersion", recorded: "v22.0.0", current: "v24.0.0" }],
  } };
  assert.match(renderReport(replayed, false), /Replay of:/);
  assert.match(renderReport(replayed, false), /nodeVersion: v22.0.0 → v24.0.0/);
  const html = renderHtmlReport(replayed, new Map());
  assert.match(html, /Replay of \/tmp\/&lt;script&gt;source&lt;\/script&gt;/);
  assert.match(html, /Execution settings changed: nodeVersion/);
  assert.doesNotMatch(html, /<script>source/);
});
