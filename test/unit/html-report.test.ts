import assert from "node:assert/strict";
import { test } from "node:test";
import { groupBySymptom, renderHtmlReport } from "../../src/html-report.ts";
import { parseProbe } from "../../src/probe.ts";
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
  assert.match(html, /<summary>Discarded <span class="count">1 probe failed/);
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
