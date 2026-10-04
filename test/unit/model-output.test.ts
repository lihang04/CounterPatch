import assert from "node:assert/strict";
import { test } from "node:test";
import { parseGeneratedProbes } from "../../src/generate.ts";

const probe = {
  id: "generated-checkout", title: 'Text with braces { } and an escaped "quote"',
  steps: [{ do: "goto", path: "/checkout" }, { do: "fill", testId: "email", value: "guest@example.com" }],
  expect: [{ path: "ui.url", equals: "/checkout" }],
};
const json = JSON.stringify({ probes: [probe] });

test("JSON probe output tolerates prose, Markdown fences, and closed leading reasoning", () => {
  for (const content of [
    json,
    `Here are your probes:\n${json}\nThese check checkout.`,
    `Here are your probes:\n\n\`\`\`json\n${json}\n\`\`\`\nDone.`,
    `\`\`\`json ${json}\`\`\``,
    `\`\`\`JSON\r\n${json}\r\n\`\`\``,
    `<think>Some analysis with an example {"probes": []}.</think>\n${json}`,
    `<think>Reasoning.</think>\n<think>More reasoning.</think>\nHere are probes:\n${json}`,
  ]) assert.equal(parseGeneratedProbes(content, 3)[0]?.title, probe.title);
});

test("JSON extraction rejects ambiguous, incomplete, and malformed batches", () => {
  for (const content of [
    `First:\n${json}\nSecond:\n${json}`,
    `Here:\n${json.slice(0, -1)}`,
    `<think>Unfinished reasoning with ${json}`,
    `Here:\n{"probes":[${JSON.stringify(probe)},]}`,
    `Here:\n{"wrapper":${json},}`,
    `Here:\n{"probes": [${JSON.stringify(probe)}]`,
    `Here:\n[${json}]`,
    "Here:\n{'probes': []}",
    "No JSON answer available.",
  ]) assert.throws(() => parseGeneratedProbes(content, 3));
});

test("presentation wrappers do not bypass probe schema or action validation", () => {
  const unsupported = { ...probe, steps: [{ do: "evaluate", script: "dangerous()" }] };
  assert.throws(() => parseGeneratedProbes(`Here:\n${JSON.stringify({ probes: [unsupported] })}`, 3), /invalid/);
  assert.throws(() => parseGeneratedProbes(`Here:\n${JSON.stringify({ probes: [probe, probe] })}`, 3), /duplicate/);
});
