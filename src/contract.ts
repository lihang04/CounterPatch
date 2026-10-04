import fs from "node:fs/promises";
import { z } from "zod";
import type { Probe } from "./probe.ts";
import type { ProbeRun } from "./runner.ts";

const id = z.string().regex(/^[a-z0-9][a-z0-9-]*$/);
const ContractSchema = z.strictObject({
  schemaVersion: z.literal(1),
  title: z.string().trim().min(1),
  requirements: z.array(z.strictObject({
    id,
    kind: z.enum(["change", "preserve"]),
    description: z.string().trim().min(1),
  })).min(1),
  // Exclusions describe scope; they never silently suppress a failing probe.
  exclusions: z.array(z.string().trim().min(1)).default([]),
});

export type TaskContract = z.infer<typeof ContractSchema>;
export type Requirement = TaskContract["requirements"][number];

export function contractJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(ContractSchema, { io: "input" });
}

export function parseContract(value: unknown, source = "inline"): TaskContract {
  const parsed = ContractSchema.safeParse(value);
  if (!parsed.success) throw new Error(`Task contract ${source} is invalid:\n${z.prettifyError(parsed.error)}`);
  const ids = new Set<string>();
  for (const requirement of parsed.data.requirements) {
    if (ids.has(requirement.id)) throw new Error(`Task contract ${source} has duplicate requirement id "${requirement.id}".`);
    ids.add(requirement.id);
  }
  return parsed.data;
}

export async function loadContract(file: string): Promise<TaskContract> {
  return parseContract(JSON.parse(await fs.readFile(file, "utf8")), file);
}

export function validateContractProbes(contract: TaskContract | undefined, probes: Probe[]): void {
  const ids = new Set<string>();
  for (const probe of probes) {
    if (ids.has(probe.id)) throw new Error(`Duplicate probe id "${probe.id}".`);
    ids.add(probe.id);
    if (!contract) {
      if (probe.requirementId) throw new Error(`Probe "${probe.id}" links to a requirement; supply --contract to verify its intent.`);
      continue;
    }
    const requirement = contract.requirements.find((r) => r.id === probe.requirementId);
    if (!requirement) throw new Error(`Probe "${probe.id}" needs a requirementId from the task contract.`);
    if (requirement.kind === "preserve" && probe.candidateOnly) {
      throw new Error(`Preservation probe "${probe.id}" must run against both snapshots (candidateOnly: false).`);
    }
  }
}

export type Observation = "both-passed" | "candidate-failed" | "baseline-failed" | "both-failed" | "candidate-only-passed" | "candidate-only-failed" | "not-executed";
export type Decision = "fulfilled" | "preserved" | "regression" | "unfulfilled" | "inconclusive";
export type ProbeAssessment = { probeId: string; observation: Observation; decision: Decision; reason: string };
export type RequirementAssessment = {
  requirement: Requirement;
  status: "met" | "unmet" | "inconclusive";
  probes: ProbeAssessment[];
};
export type ContractAssessment = {
  contract: TaskContract;
  status: "met" | "unmet" | "inconclusive";
  requirements: RequirementAssessment[];
};
type Result = { probe: Probe; control: ProbeRun | null; candidate: ProbeRun | null };

export function observationFor(control: ProbeRun | null, candidate: ProbeRun | null): Observation {
  if (!candidate) return "not-executed";
  if (!control) return candidate.status === "pass" ? "candidate-only-passed" : "candidate-only-failed";
  if (control.status === "fail") return candidate.status === "pass" ? "baseline-failed" : "both-failed";
  return candidate.status === "pass" ? "both-passed" : "candidate-failed";
}

function assessProbe(requirement: Requirement, result: Result): ProbeAssessment {
  const { probe, control, candidate } = result;
  const base = { probeId: probe.id, observation: observationFor(control, candidate) };
  if (!candidate) return { ...base, decision: "inconclusive", reason: "The candidate was not executed." };
  // Observation failures are not evidence that the application's behavior is wrong.
  const observationError = (run: ProbeRun) => Object.values(run.evidence.db).some((value) => "error" in value);
  if (observationError(candidate) || (requirement.kind === "preserve" && control && observationError(control))) {
    return { ...base, decision: "inconclusive", reason: "A database observation failed; repair the observable and rerun." };
  }
  if (requirement.kind === "change") {
    return candidate.status === "pass"
      ? { ...base, decision: "fulfilled", reason: "The candidate satisfies this probe's requested behavior." }
      : { ...base, decision: "unfulfilled", reason: "The candidate does not satisfy this probe's requested behavior; inspect the evidence and probe." };
  }
  if (!control || control.status === "fail") {
    return { ...base, decision: "inconclusive", reason: "Preservation is unverified: the baseline did not pass. This may be an existing defect or an invalid probe." };
  }
  return candidate.status === "pass"
    ? { ...base, decision: "preserved", reason: "This preservation probe passes on both snapshots." }
    : { ...base, decision: "regression", reason: "This behavior was required to remain working; the probe passed before and failed after." };
}

export function assessContract(contract: TaskContract, results: Result[]): ContractAssessment {
  validateContractProbes(contract, results.map((r) => r.probe));
  const requirements = contract.requirements.map((requirement): RequirementAssessment => {
    const probes = results.filter((r) => r.probe.requirementId === requirement.id).map((r) => assessProbe(requirement, r));
    const status = probes.some((p) => p.decision === "regression" || p.decision === "unfulfilled") ? "unmet"
      : probes.length === 0 || probes.some((p) => p.decision === "inconclusive") ? "inconclusive" : "met";
    return { requirement, status, probes };
  });
  return {
    contract, requirements,
    status: requirements.some((r) => r.status === "unmet") ? "unmet"
      : requirements.some((r) => r.status === "inconclusive") ? "inconclusive" : "met",
  };
}
