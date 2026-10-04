import fs from "node:fs/promises";
import path from "node:path";
import { HTML_REPORT_FILE, INCONCLUSIVE_MESSAGE, contractHeadline, failureReasons } from "./report.ts";
import type { ProbeRun } from "./runner.ts";
import type { ProbeResult, RunReport } from "./verify.ts";

// A single self-contained page for one verification run: no server,
// screenshots embedded, so the file can be opened or shared as is. It reads
// fully without JavaScript; the one script only enlarges screenshots.

// Screenshot path -> base64 PNG.
export type Screenshots = Map<string, string>;

export type SymptomGroup = {
  // Where the candidate ended up when that differs from control, else null.
  endedOn: string | null;
  results: ProbeResult[];
};

// Everything shown comes from the app under test or from generated probes, so
// all of it is escaped.
function esc(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

function replayNote(report: RunReport): string {
  if (!report.replay) return "";
  const fields = report.replay.executionDrift.map((change) => esc(change.field));
  return `<p>Replay of ${esc(report.replay.sourceBundle.path)}<br>Source SHA-256: ${esc(report.replay.sourceBundle.sha256)}
    ${fields.length ? `<br>Execution settings changed: ${fields.join(", ")}. See report.json for recorded and current values.` : ""}</p>`;
}

// Counterexamples that land on the same unexpected page are one symptom seen
// through several probes. This groups by symptom; it does not claim a cause.
export function groupBySymptom(results: ProbeResult[]): SymptomGroup[] {
  const groups = new Map<string, SymptomGroup>();
  for (const result of results) {
    const before = result.control?.evidence.ui.url;
    const after = result.candidate?.evidence.ui.url;
    const moved = before !== undefined && after !== undefined && before !== after;
    const key = moved ? `moved:${after}` : `probe:${result.probe.id}`;
    const group = groups.get(key) ?? { endedOn: moved ? (after as string) : null, results: [] };
    group.results.push(result);
    groups.set(key, group);
  }
  // Within a group, lead with the probe that observed the most change.
  for (const group of groups.values()) group.results.sort((a, b) => b.differences.length - a.differences.length);
  return [...groups.values()].sort((a, b) => b.results.length - a.results.length);
}

function isNetworkCall(value: unknown): value is { method: string; path: string; status: number | null; requestBody: unknown; responseBody: unknown } {
  return typeof value === "object" && value !== null && "method" in value && "path" in value && "status" in value;
}

function json(value: unknown): string {
  return `<pre>${esc(JSON.stringify(value, null, 2))}</pre>`;
}

function formatValue(value: unknown): string {
  if (value === undefined) return '<span class="absent">not observed</span>';
  if (isNetworkCall(value)) {
    const parts = [`<code>${esc(value.method)} ${esc(value.path)} → ${esc(value.status ?? "no response")}</code>`];
    if (value.requestBody !== null) parts.push(`<span class="sub">sent</span>${json(value.requestBody)}`);
    if (value.responseBody !== null) parts.push(`<span class="sub">received</span>${json(value.responseBody)}`);
    return parts.join("");
  }
  if (typeof value === "object" && value !== null) return json(value);
  return `<code>${esc(JSON.stringify(value))}</code>`;
}

// Turns an evidence path into words, keeping the raw path alongside.
function describePath(evidencePath: string): { kind: string; label: string } {
  if (evidencePath === "ui.url") return { kind: "Page", label: "Page the probe ended on" };
  const capture = /^ui\.captures\.(.+)$/.exec(evidencePath);
  if (capture) return { kind: "Page", label: `Value read from the page: ${capture[1]}` };
  const call = /^network\.calls\[(\d+)\](?:\.(.+))?$/.exec(evidencePath);
  if (call) return { kind: "Network", label: `API call ${Number(call[1]) + 1}${call[2] ? `, ${call[2]}` : ""}` };
  const row = /^db\.([^.[]+)\.(added|removed)\[(\d+)\](?:\.(.+))?$/.exec(evidencePath);
  if (row) {
    const what = row[2] === "added" ? "new row" : "removed row";
    return { kind: "Database", label: `${row[1]}: ${what} ${Number(row[3]) + 1}${row[4] ? `, ${row[4]}` : ""}` };
  }
  if (evidencePath.startsWith("db.")) return { kind: "Database", label: evidencePath.slice(3) };
  if (evidencePath.startsWith("network.")) return { kind: "Network", label: evidencePath.slice(8) };
  return { kind: "Page", label: evidencePath };
}

function differencesTable(result: ProbeResult): string {
  if (result.differences.length === 0) return "";
  const rows = result.differences
    .map((difference) => {
      const { kind, label } = describePath(difference.path);
      return `<tr>
        <th scope="row"><span class="kind kind-${kind.toLowerCase()}">${kind}</span>${esc(label)}<span class="raw">${esc(difference.path)}</span></th>
        <td>${formatValue(difference.control)}</td>
        <td>${formatValue(difference.candidate)}</td>
      </tr>`;
    })
    .join("");
  return `<table class="diff">
    <caption>What was observed</caption>
    <thead><tr><th scope="col">Evidence</th><th scope="col">Before the change</th><th scope="col">After the change</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function shot(run: ProbeRun | null, side: "Before" | "After", title: string, screenshots: Screenshots): string {
  if (!run) return "";
  const state = run.status === "pass" ? "pass" : "fail";
  const data = run.screenshot ? screenshots.get(run.screenshot) : undefined;
  const image = data
    ? `<img src="data:image/png;base64,${data}" alt="The app ${side === "Before" ? "before" : "after"} the change at the end of “${esc(title)}”, on ${esc(run.evidence.ui.url)}">`
    : '<div class="noshot">No screenshot was captured.</div>';
  return `<figure class="shot">
    <figcaption>
      <strong>${side}</strong>
      <span class="state state-${state}">${state === "pass" ? "passed" : "failed"}</span>
      <span class="where">ended on <code>${esc(run.evidence.ui.url || "no page")}</code></span>
    </figcaption>
    ${image}
  </figure>`;
}

function probeBlock(
  result: ProbeResult,
  screenshots: Screenshots,
  heading: "h3" | "h4",
  symptomPages: Set<string> = new Set(),
): string {
  const { probe, control, candidate } = result;
  const failed = result.verdict === "discarded" ? control : candidate;
  const reasons = failed && failed.status === "fail" ? failureReasons(failed) : [];
  const endedOn = candidate?.evidence.ui.url ?? "";
  const samePage = symptomPages.has(endedOn)
    ? `<p class="same">Stopped on <code>${esc(endedOn)}</code>, the same page as the counterexamples above.</p>`
    : "";
  return `<article class="probe">
    <${heading}>${esc(probe.title)}</${heading}>
    ${probe.description ? `<p class="lede">${esc(probe.description)}</p>` : ""}
    ${reasons.length > 0 ? `<ul class="reasons">${reasons.map((reason) => `<li>${esc(reason)}</li>`).join("")}</ul>` : ""}
    ${samePage}
    <button type="button" class="zoom" aria-pressed="false">Larger screenshots</button>
    <div class="shots${control ? "" : " single"}">
      ${shot(control, "Before", probe.title, screenshots)}
      ${shot(candidate, "After", probe.title, screenshots)}
    </div>
    ${differencesTable(result)}
    <p class="probe-id">Probe <code>${esc(probe.id)}</code></p>
  </article>`;
}

function symptomSection(group: SymptomGroup, screenshots: Screenshots): string {
  const [first, ...rest] = group.results as [ProbeResult, ...ProbeResult[]];
  if (group.endedOn === null) return `<section class="symptom">${probeBlock(first, screenshots, "h3")}</section>`;

  const before = [...new Set(group.results.map((result) => result.control?.evidence.ui.url ?? ""))].filter(Boolean);
  const others =
    rest.length === 0
      ? ""
      : `<details class="more">
          <summary>${plural(rest.length, "more probe")} with the same symptom</summary>
          <div class="reveal">${rest.map((result) => probeBlock(result, screenshots, "h4")).join("")}</div>
        </details>`;
  return `<section class="symptom">
    <header class="symptom-head">
      <h3>${plural(group.results.length, "probe")} now ${group.results.length === 1 ? "ends" : "end"} on <code>${esc(group.endedOn)}</code></h3>
      <p>Before the change ${group.results.length === 1 ? "it" : "they"} ended on ${before.map((url) => `<code>${esc(url)}</code>`).join(" or ")}.</p>
    </header>
    ${probeBlock(first, screenshots, "h4")}
    ${others}
  </section>`;
}

function headline(report: RunReport, groups: SymptomGroup[], unvalidated: number): { title: string; detail: string; tone: string } {
  if (report.outcome === "inconclusive") {
    return { tone: "warn", title: "Verification inconclusive.", detail: INCONCLUSIVE_MESSAGE };
  }
  const diverged = groups.reduce((sum, group) => sum + group.results.length, 0);
  if (diverged > 0) {
    const noBaseline = unvalidated > 0 ? ` ${plural(unvalidated, "more probe")} failed with no baseline to compare against.` : "";
    return {
      tone: "fail",
      title: `${plural(diverged, "probe")} passed before the change and ${diverged === 1 ? "fails" : "fail"} after it.`,
      detail: `${diverged === 1 ? "It shows" : "They show"} ${plural(groups.length, "distinct symptom")}.${noBaseline}`,
    };
  }
  if (unvalidated > 0) {
    return {
      tone: "warn",
      title: `${plural(unvalidated, "probe")} of new behaviour failed.`,
      detail: "Nothing that worked before the change was seen to break. These probes cover behaviour that did not exist before, so there is no baseline to check them against.",
    };
  }
  return {
    tone: "pass",
    title: "No counterexample discovered.",
    detail: `This is not a statement that the change is safe. It covers the ${plural(report.results.length, "probe")} listed below and nothing else.`,
  };
}

const STYLE = `
:root {
  --bg: oklch(1 0 0);
  --panel: oklch(0.972 0.004 70);
  --line: oklch(0.895 0.006 70);
  --ink: oklch(0.22 0.012 70);
  --ink-2: oklch(0.43 0.012 70);
  --brand: oklch(0.6 0.124 70);
  --brand-ink: oklch(0.44 0.1 70);
  --brand-tint: oklch(0.955 0.045 80);
  --fail: oklch(0.47 0.17 27);
  --fail-tint: oklch(0.955 0.025 27);
  --pass: oklch(0.43 0.11 152);
  --pass-tint: oklch(0.955 0.035 152);
  --mono: ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, monospace;
  --ease: cubic-bezier(0.22, 1, 0.36, 1);
}
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--ink);
  font: 1rem/1.55 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
}
code, pre { font-family: var(--mono); font-size: 0.875em; }
pre { margin: 0.25rem 0 0; white-space: pre-wrap; overflow-wrap: anywhere; }
h1, h2, h3, h4 { margin: 0; text-wrap: balance; line-height: 1.25; }
p { margin: 0; }
:focus-visible { outline: 2px solid var(--brand); outline-offset: 2px; border-radius: 4px; }

.top {
  display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 0.5rem 1.5rem;
  padding: 0.875rem 1.5rem; border-bottom: 1px solid var(--line);
}
.mark { display: inline-flex; align-items: center; gap: 0.5rem; font-weight: 650; letter-spacing: -0.01em; }
.mark::before { content: ""; width: 0.75rem; height: 0.75rem; border-radius: 2px; background: var(--brand); }
.top .meta { color: var(--ink-2); font-size: 0.875rem; }

main { max-width: 70rem; margin: 0 auto; padding: 2.5rem 1.5rem 4rem; }
main > section + section { margin-top: 3rem; }

.verdict h1 { font-size: 1.875rem; letter-spacing: -0.015em; max-width: 46ch; }
.verdict .detail { margin-top: 0.625rem; max-width: 68ch; color: var(--ink-2); font-size: 1.0625rem; }
.verdict.tone-fail h1 { color: var(--fail); }
.verdict.tone-pass h1 { color: var(--pass); }
.verdict.tone-warn h1 { color: var(--brand-ink); }
.stats { display: flex; flex-wrap: wrap; gap: 0.5rem 2rem; margin: 1.5rem 0 0; padding: 0.875rem 0 0; border-top: 1px solid var(--line); }
.stats div { display: flex; align-items: baseline; gap: 0.5rem; }
.stats dt { color: var(--ink-2); font-size: 0.875rem; }
.stats dd { margin: 0; font-weight: 650; font-variant-numeric: tabular-nums; }

h2 { font-size: 1.25rem; }
h2 + .note { margin-top: 0.375rem; max-width: 68ch; color: var(--ink-2); }

.symptom { margin-top: 1.5rem; padding-top: 1.5rem; border-top: 1px solid var(--line); }
.symptom-head h3 { font-size: 1.125rem; }
.symptom-head p { margin-top: 0.25rem; color: var(--ink-2); }
.symptom-head + .probe { margin-top: 1.25rem; }

.probe h3 { font-size: 1.125rem; }
.probe h4 { font-size: 1rem; }
.probe .lede { margin-top: 0.25rem; max-width: 68ch; color: var(--ink-2); }
.reasons { margin: 0.75rem 0 0; padding: 0.75rem 1rem 0.75rem 2rem; border-radius: 8px; background: var(--fail-tint); color: var(--fail); max-width: 78ch; }
.reasons li + li { margin-top: 0.25rem; }
.probe-id { margin-top: 0.75rem; color: var(--ink-2); font-size: 0.8125rem; }
.same { margin-top: 0.75rem; color: var(--ink-2); }

.zoom {
  display: none; margin-top: 1rem; padding: 0.25rem 0.75rem; border: 1px solid var(--line); border-radius: 6px;
  background: var(--bg); color: var(--ink); font: inherit; font-size: 0.875rem; cursor: pointer;
  transition: background-color 150ms var(--ease), border-color 150ms var(--ease);
}
.js .zoom { display: inline-block; }
.zoom:hover { background: var(--panel); border-color: var(--ink-2); }
.zoom:active { background: var(--line); }
.zoom[aria-pressed="true"] { background: var(--panel); border-color: var(--ink-2); }
.zoom + .shots { margin-top: 0.75rem; }
.shots.large, .shots.single.large { grid-template-columns: minmax(0, 1fr); }

.shots { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 1rem; margin-top: 1rem; }
.shots.single { grid-template-columns: minmax(0, 35rem); }
.shot { margin: 0; }
.shot figcaption { display: flex; flex-wrap: wrap; align-items: center; gap: 0.375rem 0.625rem; margin-bottom: 0.5rem; }
.shot .where { color: var(--ink-2); font-size: 0.875rem; overflow-wrap: anywhere; }
.shot img { display: block; width: 100%; height: auto; border: 1px solid var(--line); border-radius: 8px; }
.noshot { padding: 2rem 1rem; border: 1px dashed var(--line); border-radius: 8px; color: var(--ink-2); text-align: center; }
.state { padding: 0.0625rem 0.5rem; border-radius: 999px; font-size: 0.8125rem; font-weight: 600; }
.state-pass { background: var(--pass-tint); color: var(--pass); }
.state-fail { background: var(--fail-tint); color: var(--fail); }
.state-warn { background: var(--brand-tint); color: var(--brand-ink); }

.diff { width: 100%; margin-top: 1.25rem; border-collapse: collapse; table-layout: fixed; font-size: 0.9375rem; }
.diff caption { padding-bottom: 0.5rem; text-align: left; font-weight: 650; }
.diff th, .diff td { padding: 0.625rem 0.75rem; border: 1px solid var(--line); text-align: left; vertical-align: top; overflow-wrap: anywhere; }
.diff thead th { background: var(--panel); font-size: 0.8125rem; font-weight: 600; color: var(--ink-2); }
.diff tbody th { width: 30%; font-weight: 500; }
.kind { display: inline-block; margin-right: 0.5rem; padding: 0 0.375rem; border: 1px solid var(--line); border-radius: 4px; background: var(--panel); color: var(--ink-2); font-size: 0.75rem; font-weight: 600; }
.raw { display: block; margin-top: 0.125rem; color: var(--ink-2); font: 0.75rem/1.4 var(--mono); }
.sub { display: block; margin-top: 0.375rem; color: var(--ink-2); font-size: 0.75rem; }
.absent { color: var(--ink-2); font-style: italic; }

details { border-top: 1px solid var(--line); }
details:last-of-type { border-bottom: 1px solid var(--line); }
summary { display: flex; align-items: center; gap: 0.625rem; padding: 0.875rem 0.25rem; cursor: pointer; font-weight: 600; list-style: none; border-radius: 6px; transition: background-color 150ms var(--ease); }
summary::-webkit-details-marker { display: none; }
summary::before { content: ""; flex: none; width: 0.5rem; height: 0.5rem; border-right: 2px solid var(--ink-2); border-bottom: 2px solid var(--ink-2); transform: rotate(-45deg); transition: transform 180ms var(--ease); }
details[open] > summary::before { transform: rotate(45deg); }
summary:hover { background: var(--panel); }
summary .count { color: var(--ink-2); font-weight: 500; }
.reveal { padding: 0.25rem 0.25rem 1.5rem; }
.reveal > .probe + .probe { margin-top: 2rem; padding-top: 1.5rem; border-top: 1px solid var(--line); }
.more { margin-top: 1.5rem; }

.rows { margin: 0; padding: 0; list-style: none; }
.rows li { display: flex; flex-wrap: wrap; align-items: baseline; gap: 0.25rem 0.75rem; padding: 0.5rem 0; }
.rows li + li { border-top: 1px solid var(--line); }
.rows .why { flex-basis: 100%; color: var(--ink-2); font-size: 0.875rem; overflow-wrap: anywhere; }
.files { margin: 0; padding: 0; list-style: none; font: 0.875rem/1.7 var(--mono); }
.files span { display: inline-block; width: 1.5rem; color: var(--ink-2); }

footer { max-width: 70rem; margin: 0 auto; padding: 1.25rem 1.5rem 2.5rem; border-top: 1px solid var(--line); color: var(--ink-2); font-size: 0.8125rem; overflow-wrap: anywhere; }

@media (max-width: 44rem) {
  main { padding: 1.75rem 1rem 3rem; }
  .top, footer { padding-left: 1rem; padding-right: 1rem; }
  .verdict h1 { font-size: 1.5rem; }
  .shots { grid-template-columns: minmax(0, 1fr); }
  .js .zoom { display: none; }
  summary { flex-wrap: wrap; }
  summary .count { flex-basis: 100%; padding-left: 1.125rem; }
  .diff caption { display: block; }
  .diff, .diff tbody, .diff tr, .diff th, .diff td { display: block; width: auto; }
  .diff thead { display: none; }
  .diff tr { margin-top: 0.75rem; border: 1px solid var(--line); border-radius: 8px; overflow: hidden; }
  .diff th, .diff td { border: 0; }
  .diff tbody th { width: auto; background: var(--panel); }
  .diff td { border-top: 1px solid var(--line); }
  .diff td::before { display: block; margin-bottom: 0.125rem; color: var(--ink-2); font-size: 0.75rem; font-weight: 600; }
  .diff td:nth-of-type(1)::before { content: "Before the change"; }
  .diff td:nth-of-type(2)::before { content: "After the change"; }
}
@media (prefers-reduced-motion: reduce) {
  summary, summary::before, .zoom { transition: none; }
}
`;

// Progressive enhancement only: stacks a probe's screenshots at full width.
const SCRIPT = `
document.documentElement.classList.add("js");
document.addEventListener("click", (event) => {
  const button = event.target.closest("button.zoom");
  if (!button) return;
  const large = button.getAttribute("aria-pressed") !== "true";
  button.setAttribute("aria-pressed", String(large));
  button.textContent = large ? "Smaller screenshots" : "Larger screenshots";
  button.nextElementSibling.classList.toggle("large", large);
});
`;

export function renderHtmlReport(report: RunReport, screenshots: Screenshots): string {
  if (report.assessment) return renderContractReport(report, screenshots);
  const { results } = report;
  const diverged = results.filter((result) => result.verdict === "diverged");
  const unvalidated = results.filter((result) => result.verdict === "candidate-only-failed");
  const checked = results.filter((result) => result.verdict === "held" || result.verdict === "candidate-only-passed");
  const discarded = results.filter((result) => result.verdict === "discarded");
  const differential = results.filter((result) => !result.probe.candidateOnly).length;
  const groups = groupBySymptom(diverged);
  const symptomPages = new Set(groups.flatMap((group) => (group.endedOn === null ? [] : [group.endedOn])));
  const verdict = headline(report, groups, unvalidated.length);

  const counterexamples =
    groups.length === 0
      ? ""
      : `<section>
          <h2>Counterexamples</h2>
          <p class="note">Each of these probes passed on the app as it was before the task and fails on the app as it is now.</p>
          ${groups.map((group) => symptomSection(group, screenshots)).join("")}
        </section>`;

  const noBaseline =
    unvalidated.length === 0
      ? ""
      : `<section>
          <h2>Failed with no baseline</h2>
          <p class="note">These probes exercise behaviour that only exists after the change. A failure here may be a real defect or a wrong probe; nothing from before the change can tell them apart.</p>
          ${unvalidated.map((result) => `<section class="symptom">${probeBlock(result, screenshots, "h3", symptomPages)}</section>`).join("")}
        </section>`;

  const checkedList = checked
    .map((result) => {
      const changed = result.differences.map((difference) => difference.path);
      const tag =
        result.verdict === "candidate-only-passed"
          ? '<span class="state state-pass">passed after</span>'
          : '<span class="state state-pass">passed before and after</span>';
      const note =
        changed.length > 0
          ? `<span class="why">Passes, but ${plural(changed.length, "observed value")} changed: <code>${changed.map(esc).join("</code>, <code>")}</code></span>`
          : "";
      return `<li><span>${esc(result.probe.title)}</span>${tag}${changed.length > 0 ? '<span class="state state-warn">values changed</span>' : ""}${note}</li>`;
    })
    .join("");

  const discardedList = discarded
    .map((result) => {
      const reasons = result.control ? failureReasons(result.control) : [];
      return `<li><span>${esc(result.probe.title)}</span><span class="why">${esc(reasons.join(" · "))}</span></li>`;
    })
    .join("");

  const lists = [
    checked.length > 0
      ? `<details${groups.length + unvalidated.length === 0 ? " open" : ""}>
          <summary>Checked <span class="count">${plural(checked.length, "probe")} passed</span></summary>
          <div class="reveal"><ul class="rows">${checkedList}</ul></div>
        </details>`
      : "",
    discarded.length > 0
      ? `<details${report.outcome === "inconclusive" ? " open" : ""}>
          <summary>Unverified preservation <span class="count">${plural(discarded.length, "probe")} failed on baseline; may be an existing defect or an invalid probe</span></summary>
          <div class="reveal"><ul class="rows">${discardedList}</ul></div>
        </details>`
      : "",
    `<details>
      <summary>Files changed <span class="count">${plural(report.changed.length, "file")} since the baseline</span></summary>
      <div class="reveal"><ul class="files">${report.changed.map((file) => `<li><span>${esc(file.status)}</span>${esc(file.path)}</li>`).join("")}</ul></div>
    </details>`,
  ].join("");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>CounterPatch report: ${esc(verdict.title)}</title>
<style>${STYLE}</style>
</head>
<body>
<header class="top">
  <span class="mark">CounterPatch</span>
  <span class="meta">Compared with the working tree recorded ${esc(report.baseline.createdAt.replace("T", " ").replace(/\.\d+Z$/, " UTC"))}</span>
</header>
<main>
  <section class="verdict tone-${verdict.tone}">
    <h1>${esc(verdict.title)}</h1>
    <p class="detail">${esc(verdict.detail)}</p>
    <dl class="stats">
      <div><dt>Probes run</dt><dd>${results.length}</dd></div>
      <div><dt>Valid on the app before the change</dt><dd>${differential - discarded.length}</dd></div>
      <div><dt>Unverified on baseline</dt><dd>${discarded.length}</dd></div>
      <div><dt>New behaviour only</dt><dd>${results.length - differential}</dd></div>
    </dl>
  </section>
  ${counterexamples}
  ${noBaseline}
  <section>${lists}</section>
</main>
<footer>${replayNote(report)}Full evidence, server logs and databases for this run: ${esc(report.runDir)}</footer>
<script>${SCRIPT}</script>
</body>
</html>
`;
}

function renderContractReport(report: RunReport, screenshots: Screenshots): string {
  const assessment = report.assessment!;
  const headline = contractHeadline(assessment);
  const requirements = assessment.requirements.map((entry) => {
    const tone = entry.status === "met" ? "pass" : entry.status === "unmet" ? "fail" : "warn";
    return `<section>
      <h2><span class="state state-${tone}">${esc(entry.status)}</span> ${esc(entry.requirement.description)}</h2>
      <p class="note">${esc(entry.requirement.kind)} · ${esc(entry.requirement.id)}</p>
      ${entry.probes.length === 0 ? '<p class="note">No probes cover this requirement.</p>' : ""}
      ${entry.probes.map((probe) => {
        const result = report.results.find((r) => r.probe.id === probe.probeId);
        return `<details${entry.status !== "met" ? " open" : ""}>
          <summary>${esc(probe.decision)}: ${esc(result?.probe.title ?? probe.probeId)}</summary>
          <div class="reveal"><p>${esc(probe.reason)}</p>
            <p class="note">Observed: ${esc(probe.observation)}. Before and after show the same probe's expectations; requested new behavior may fail on the baseline.</p>
            ${result ? probeBlock(result, screenshots, "h3") : ""}
          </div>
        </details>`;
      }).join("")}
    </section>`;
  }).join("");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>CounterPatch report: ${esc(headline.title)}</title><style>${STYLE}</style></head><body>
<header class="top"><span class="mark">CounterPatch</span><span class="meta">${esc(assessment.contract.title)}</span></header>
<main><section class="verdict tone-${headline.tone}"><h1>${esc(headline.title)}</h1><p class="detail">${esc(headline.detail)}</p></section>
${requirements}
${assessment.contract.exclusions.length ? `<section><h2>Outside this task's scope</h2><ul>${assessment.contract.exclusions.map((e) => `<li>${esc(e)}</li>`).join("")}</ul></section>` : ""}
<section><details><summary>Files changed (${report.changed.length})</summary><ul class="files">${report.changed.map((f) => `<li><span>${esc(f.status)}</span>${esc(f.path)}</li>`).join("")}</ul></details></section>
</main><footer>${replayNote(report)}Evidence: ${esc(report.runDir)}${report.bundle ? `<br>Verification bundle: ${esc(report.bundle.path)}<br>SHA-256: ${esc(report.bundle.sha256)}` : ""}</footer>
<script>${SCRIPT}</script></body></html>`;
}

export async function writeHtmlReport(report: RunReport): Promise<string> {
  const screenshots: Screenshots = new Map();
  for (const result of report.results) {
    for (const run of [result.control, result.candidate]) {
      if (!run?.screenshot || screenshots.has(run.screenshot)) continue;
      const data = await fs.readFile(run.screenshot).catch(() => null);
      if (data) screenshots.set(run.screenshot, data.toString("base64"));
    }
  }
  const file = path.join(report.runDir, HTML_REPORT_FILE);
  await fs.writeFile(file, renderHtmlReport(report, screenshots));
  return file;
}
