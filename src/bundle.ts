import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { parseContract, validateContractProbes, type TaskContract } from "./contract.ts";
import { exec } from "./exec.ts";
import { parseManifest } from "./manifest.ts";
import { parseProbe, type Probe } from "./probe.ts";
import { PROBE_LIMITS, type ProbeLimits } from "./runner.ts";
import { repoRoot, subtree, type Baseline } from "./snapshot.ts";

export function contentHash(value: unknown): string {
  const canonical = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(canonical);
    if (input !== null && typeof input === "object") return Object.fromEntries(
      Object.entries(input).filter(([, v]) => v !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
        .map(([key, v]) => [key, canonical(v)]),
    );
    return input;
  };
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

export type BundleReference = { path: string; sha256: string };
export type ReplayInfo = { sourceBundle: BundleReference; executionDrift: { field: string; recorded: string; current: string }[] };

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const objectId = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
const limitsSchema = z.strictObject({
  stepTimeoutMs: z.number().int().positive().max(715_827_882),
  settleQuietMs: z.number().int().positive().max(2_147_483_647),
});
const referenceSchema = z.strictObject({ path: z.string().min(1), sha256: sha256Schema });
const BundleSchema = z.strictObject({
  schemaVersion: z.literal(1), createdAt: z.iso.datetime(),
  repository: z.string().refine(path.isAbsolute, "Repository must be an absolute path"),
  appPath: z.string().refine((value) => value === "" || (!path.posix.isAbsolute(value) &&
    path.posix.normalize(value) === value && !value.split("/").includes("..")), "App path must be inside the repository"),
  snapshots: z.strictObject({
    baseline: z.strictObject({ commit: objectId, tree: objectId, createdAt: z.iso.datetime() }),
    candidateTree: objectId, controlAppTree: objectId, candidateAppTree: objectId,
    refs: z.strictObject({
      control: z.string().regex(/^refs\/counterpatch\/runs\/[^/]+\/control$/),
      candidate: z.string().regex(/^refs\/counterpatch\/runs\/[^/]+\/candidate$/),
    }),
  }),
  contract: z.unknown(), probes: z.array(z.unknown()),
  manifests: z.strictObject({ control: z.unknown(), candidate: z.unknown() }),
  execution: z.strictObject({
    nodeVersion: z.string().min(1), platform: z.string().min(1), architecture: z.string().min(1),
    verifierSourceHash: sha256Schema, dependencyLockHash: sha256Schema, probeLimits: limitsSchema,
    preparation: z.enum(["cached", "fresh"]).optional(),
  }),
  replayOf: referenceSchema.optional(),
  sha256: sha256Schema,
});
export type VerificationBundle = Omit<z.infer<typeof BundleSchema>, "contract" | "probes"> & {
  contract: TaskContract | null; probes: Probe[];
};

export async function executionIdentity(probeLimits: ProbeLimits = PROBE_LIMITS) {
  const sourceDir = new URL("./", import.meta.url);
  const sourceFiles = (await fs.readdir(sourceDir)).filter((name) => name.endsWith(".ts")).sort();
  const source: Record<string, string> = {};
  for (const name of sourceFiles) source[name] = await fs.readFile(new URL(name, sourceDir), "utf8");
  return {
    nodeVersion: process.version, platform: process.platform, architecture: process.arch,
    verifierSourceHash: contentHash(source),
    dependencyLockHash: contentHash(await fs.readFile(new URL("../package-lock.json", import.meta.url), "utf8")),
    probeLimits,
  };
}

// Check the original serialized payload before normalizing probes or contract
// defaults. A digest detects edits; the Git checks below bind inputs to objects.
export async function loadVerificationBundle(file: string): Promise<VerificationBundle> {
  if ((await fs.stat(file)).size > 10_000_000) throw new Error("Verification bundle exceeds 10 MB.");
  const raw = JSON.parse(await fs.readFile(file, "utf8")) as unknown;
  const parsed = BundleSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`Verification bundle ${file} is invalid:\n${z.prettifyError(parsed.error)}`);
  const { sha256, ...payload } = raw as z.infer<typeof BundleSchema>;
  if (contentHash(payload) !== sha256) throw new Error("Verification bundle checksum does not match its contents.");
  const contract = parsed.data.contract === null ? null : parseContract(parsed.data.contract, "verification bundle");
  const probes = parsed.data.probes.map((probe) => parseProbe(probe, "verification bundle"));
  validateContractProbes(contract ?? undefined, probes);
  for (const role of ["control", "candidate"] as const) parseManifest(parsed.data.manifests[role], `Bundle ${role} manifest`);
  return { ...parsed.data, contract, probes };
}

export async function validateBundleRepository(bundle: VerificationBundle, repo?: string): Promise<string> {
  const root = await fs.realpath(await repoRoot(repo ?? bundle.repository));
  const trees = [bundle.snapshots.baseline.tree, bundle.snapshots.candidateTree,
    bundle.snapshots.controlAppTree, bundle.snapshots.candidateAppTree];
  for (const tree of new Set(trees)) {
    const type = await exec("git", ["cat-file", "-t", tree], { cwd: root }).then((r) => r.stdout.trim(), () => "missing");
    if (type !== "tree") throw new Error(`Replay snapshot ${tree} is ${type}. Use a repository containing the retained Git objects.`);
  }
  for (const role of ["control", "candidate"] as const) {
    const tree = role === "control" ? bundle.snapshots.baseline.tree : bundle.snapshots.candidateTree;
    const appTree = role === "control" ? bundle.snapshots.controlAppTree : bundle.snapshots.candidateAppTree;
    if (await subtree(root, tree, bundle.appPath) !== appTree) throw new Error(`Bundle ${role} app tree does not match its repository snapshot.`);
    const manifest = JSON.parse((await exec("git", ["show", `${appTree}:counterpatch.manifest.json`], { cwd: root })).stdout);
    if (contentHash(manifest) !== contentHash(bundle.manifests[role])) throw new Error(`Bundle ${role} manifest differs from its retained snapshot.`);
  }
  return root;
}

// Capture inputs before any app command runs. Git refs retain both trees even
// after the baseline moves and Git performs garbage collection. This is a
// local audit record, not an execution sandbox or a hermetic environment.
export async function writeVerificationBundle(options: {
  root: string; appPath: string; baseline: Baseline; candidateTree: string;
  controlAppTree: string; candidateAppTree: string;
  runDir: string; probes: Probe[]; contract?: TaskContract;
  probeLimits?: ProbeLimits; fresh?: boolean; replayOf?: BundleReference;
}): Promise<BundleReference> {
  const git = async (...args: string[]) => (await exec("git", args, { cwd: options.root })).stdout.trim();
  const manifests: Record<string, unknown> = {};
  for (const [role, tree] of [["control", options.controlAppTree], ["candidate", options.candidateAppTree]] as const) {
    manifests[role] = JSON.parse(await git("show", `${tree}:counterpatch.manifest.json`));
  }
  const refs = {
    control: `refs/counterpatch/runs/${path.basename(options.runDir)}/control`,
    candidate: `refs/counterpatch/runs/${path.basename(options.runDir)}/candidate`,
  };
  await exec("git", ["update-ref", "--stdin"], {
    cwd: options.root,
    input: `start\ncreate ${refs.control} ${options.baseline.tree}\ncreate ${refs.candidate} ${options.candidateTree}\nprepare\ncommit\n`,
  });
  const payload = {
    schemaVersion: 1, createdAt: new Date().toISOString(),
    repository: options.root, appPath: options.appPath,
    snapshots: { baseline: options.baseline, candidateTree: options.candidateTree,
      controlAppTree: options.controlAppTree, candidateAppTree: options.candidateAppTree, refs },
    contract: options.contract ?? null, probes: options.probes, manifests,
    execution: { ...await executionIdentity(options.probeLimits), preparation: options.fresh ? "fresh" : "cached" },
    replayOf: options.replayOf,
  };
  const sha256 = contentHash(payload);
  const file = path.join(options.runDir, "bundle.json");
  await fs.writeFile(file, `${JSON.stringify({ ...payload, sha256 }, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  return { path: file, sha256 };
}
