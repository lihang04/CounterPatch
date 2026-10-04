import fs from "node:fs/promises";
import { assessContract, parseContract } from "../src/contract.ts";
import { checkExpectation } from "../src/evidence.ts";
import { parseProbe } from "../src/probe.ts";
import type { ProbeRun } from "../src/runner.ts";

// Labeled observations test decision quality, separately from browser execution
// and model probe quality. The checkout scenario also runs in test/e2e.ts.
export async function evaluateContractCorpus() {
  const cases: {
    id: string; kind: "change" | "preserve"; before: string | null; after: string; expect: string;
    status: string; decision: string;
  }[] = JSON.parse(await fs.readFile(new URL("./fixtures/contract-cases.json", import.meta.url), "utf8"));
  return cases.map((entry) => {
    const contract = parseContract({ schemaVersion: 1, title: entry.id,
      requirements: [{ id: entry.id, kind: entry.kind, description: entry.id }] });
    const probe = parseProbe({ id: entry.id, title: entry.id, requirementId: entry.id, candidateOnly: entry.before === null,
      steps: [{ do: "goto", path: "/checkout" }], expect: [{ path: "ui.url", equals: entry.expect }] }, "corpus");
    const run = (url: string): ProbeRun => {
      const evidence = { ui: { url, captures: {} }, network: { calls: [], last: {} }, db: {} };
      const expectations = probe.expect.map((expectation) => checkExpectation(evidence, expectation));
      return { evidence, expectations, status: expectations.every((e) => e.ok) ? "pass" : "fail", stepFailure: null, screenshot: null, durationMs: 0 };
    };
    const assessment = assessContract(contract, [{ probe, control: entry.before === null ? null : run(entry.before), candidate: run(entry.after) }]);
    return { id: entry.id, expected: entry.status, actual: assessment.status,
      expectedDecision: entry.decision, actualDecision: assessment.requirements[0]!.probes[0]!.decision };
  });
}
