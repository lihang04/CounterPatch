import { evaluateContractCorpus } from "./contract-corpus.ts";

const started = Date.now();
const cases = await evaluateContractCorpus();
const mismatches = cases.filter((c) => c.expected !== c.actual || c.expectedDecision !== c.actualDecision);
const actualDefects = cases.filter((c) => c.expected === "unmet");
const cleanCases = cases.filter((c) => c.expected === "met");
console.log(JSON.stringify({
  scope: "Labeled decision cases; does not measure model quality, flakiness, or overall application coverage.",
  cases: cases.length, correct: cases.length - mismatches.length,
  detectionRate: actualDefects.filter((c) => c.actual === "unmet").length / actualDefects.length,
  falseAlarmRate: cleanCases.filter((c) => c.actual === "unmet").length / cleanCases.length,
  inconclusive: cases.filter((c) => c.actual === "inconclusive").length,
  durationMs: Date.now() - started, modelCalls: 0, mismatches,
}, null, 2));
process.exitCode = mismatches.length ? 1 : 0;
