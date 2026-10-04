import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { exec } from "../../src/exec.ts";
import { contentHash } from "../../src/bundle.ts";
import { parseContract } from "../../src/contract.ts";
import { generate, generationContext, parseGeneratedProbes } from "../../src/generate.ts";
import { modelConfig } from "../../src/model.ts";
import { loadProbes, probeJsonSchema } from "../../src/probe.ts";
import { readBaseline, recordBaseline } from "../../src/snapshot.ts";

const probe = {
  id: "generated-home", title: "Home loads", steps: [{ do: "goto", path: "/" }],
  expect: [{ path: "ui.url", equals: "/" }],
};
const config = modelConfig({ model: "fake-model" }, { OPENROUTER_API_KEY: "test-secret" });
const response = (probes: unknown[]) => Response.json({
  choices: [{ message: { content: JSON.stringify({ probes }) }, finish_reason: "stop" }],
  usage: { total_tokens: 123 },
});

test("generation binds probes to a captured contract and rejects invalid associations", async (t) => {
  const f = await fixture();
  t.after(() => fs.rm(f.dir, { recursive: true, force: true }));
  const contract = parseContract({ schemaVersion: 1, title: "Preserve home",
    requirements: [{ id: "home", kind: "preserve", description: "Home stays available" },
      { id: "checkout", kind: "preserve", description: "Guest checkout still works" }] });
  const linked = { ...probe, requirementId: "home" };
  const out = path.join(f.dir, "contract-generation");
  const generated = await generate({ repo: f.repo, app: "app", prompt: contract.title, contract, config, out }, async (_url, init) => {
    const request = JSON.parse(init!.body as string);
    assert.deepEqual(JSON.parse(request.messages[1].content).taskContract, contract);
    assert.match(request.messages[0].content, /assert the requested AFTER behavior/);
    return response([linked]);
  });
  assert.equal(generated.metadata.contractHash, contentHash(contract));
  assert.deepEqual(generated.metadata.uncoveredRequirementIds, ["checkout"]);
  assert.deepEqual(JSON.parse(await fs.readFile(generated.contractFile!, "utf8")), contract);
  assert.equal((await loadProbes([generated.probesDir]))[0]?.requirementId, "home");
  for (const [name, invalidProbe] of [
    ["unlinked", probe], ["unknown", { ...linked, requirementId: "invented" }],
    ["candidate-only-preserve", { ...linked, candidateOnly: true }],
  ] as const) {
    const failed = path.join(f.dir, name);
    await assert.rejects(generate({ repo: f.repo, app: "app", prompt: contract.title, contract, config, out: failed }, async () => response([invalidProbe])), /requirementId|both snapshots/);
    await assert.rejects(fs.stat(failed), { code: "ENOENT" });
  }
});

async function fixture() {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "counterpatch-generate-")));
  const repo = path.join(dir, "repo");
  const app = path.join(repo, "app");
  await fs.mkdir(app, { recursive: true });
  await exec("git", ["init", "--quiet"], { cwd: repo });
  await fs.writeFile(path.join(repo, ".gitignore"), ".env\nignored.ts\n");
  await fs.writeFile(path.join(app, "counterpatch.manifest.json"), JSON.stringify({
    name: "fixture", framework: "nextjs", commands: { install: "true", start: "true", resetDatabase: "true" },
    readiness: { path: "/" }, network: { include: ["/api/"] }, database: { observables: {} },
  }));
  await fs.writeFile(path.join(app, "page.tsx"), '<input data-testid="original" />');
  const baseline = await recordBaseline(repo);
  await fs.writeFile(path.join(app, "page.tsx"), '<input data-testid="changed" />');
  await fs.writeFile(path.join(app, "new.ts"), "export const newlyAdded = true;");
  await fs.writeFile(path.join(app, ".env"), "PRIVATE_KEY=ignored-secret");
  await fs.writeFile(path.join(app, ".env.local.ts"), "tracked-env-secret");
  await fs.writeFile(path.join(app, "ignored.ts"), "ignored-source-secret");
  await fs.writeFile(path.join(app, "credentials.txt"), "excluded-secret");
  await fs.writeFile(path.join(repo, "outside.ts"), "outside-source-secret");
  return { dir, repo, app, baseline };
}

test("generation context captures both snapshots, untracked source and a scoped diff", async (t) => {
  const f = await fixture();
  t.after(() => fs.rm(f.dir, { recursive: true, force: true }));
  const input = await generationContext(f.repo, "app", "Keep checkout working.");
  assert.equal(input.baseline, f.baseline.commit);
  assert.match(input.context.baseline.sources.find((s) => s.path === "page.tsx")!.content, /original/);
  assert.match(input.context.candidate.sources.find((s) => s.path === "page.tsx")!.content, /changed/);
  assert.ok(input.context.candidate.sources.some((s) => s.path === "new.ts"));
  assert.match(input.context.diff, /newlyAdded/);
  assert.doesNotMatch(JSON.stringify(input.context), /ignored-secret|tracked-env-secret|ignored-source-secret|excluded-secret|outside-source-secret/);
  assert.deepEqual(await readBaseline(f.repo), f.baseline);
  assert.equal((await exec("git", ["ls-files"], { cwd: f.repo })).stdout, "", "generation touched the real index");
});

for (const direction of ["file-to-directory", "directory-to-file"] as const) {
  test(`generation diff excludes private descendants during ${direction} replacements`, async (t) => {
    const f = await fixture();
    t.after(() => fs.rm(f.dir, { recursive: true, force: true }));
    const target = path.join(f.app, "legacy.ts");
    const createFile = () => fs.writeFile(target, "export const originalFile = true;\n");
    const createDirectory = async () => {
      await fs.mkdir(path.join(target, "tests"), { recursive: true });
      await fs.writeFile(path.join(target, "public.ts"), "export const nestedSource = true;\n");
      await fs.writeFile(path.join(target, ".env"), "PRIVATE_KEY=diff-env-secret\n");
      await fs.writeFile(path.join(target, "credentials.txt"), "diff-credentials-secret\n");
      await fs.writeFile(path.join(target, "tests", "hidden.ts"), "diff-test-secret\n");
      // The regression concerns excluded files that nevertheless exist in
      // a snapshot, including an explicitly tracked, ignored .env file.
      await exec("git", ["add", "-f", "--", "app/legacy.ts/.env"], { cwd: f.repo });
    };
    if (direction === "file-to-directory") await createFile();
    else await createDirectory();
    await recordBaseline(f.repo);
    await fs.rm(target, { recursive: true });
    if (direction === "file-to-directory") await createDirectory();
    else await createFile();

    const input = await generationContext(f.repo, "app", "Keep public behavior working.");
    assert.doesNotMatch(JSON.stringify(input.context), /diff-env-secret|diff-credentials-secret|diff-test-secret/);
    assert.match(input.context.diff, /originalFile/);
    assert.match(input.context.diff, /nestedSource/);
    const removed = direction === "file-to-directory" ? "originalFile" : "nestedSource";
    const added = direction === "file-to-directory" ? "nestedSource" : "originalFile";
    assert.ok(input.context.diff.includes(`-export const ${removed} = true;`));
    assert.ok(input.context.diff.includes(`+export const ${added} = true;`));
  });
}

test("generation diff preserves exact source paths containing Git metacharacters and newlines", async (t) => {
  const f = await fixture();
  t.after(() => fs.rm(f.dir, { recursive: true, force: true }));
  const filename = ":(glob)[*]\t\n.ts";
  const source = path.join(f.app, "nested", filename);
  await fs.mkdir(path.dirname(source));
  await fs.writeFile(source, "export const beforeOddPath = true;\n");
  await recordBaseline(f.repo);
  await fs.writeFile(source, "export const afterOddPath = true;\n");

  const input = await generationContext(f.repo, "app", "Keep unusual source files working.");
  assert.ok(input.context.baseline.sources.some((entry) => entry.path === `nested/${filename}`));
  assert.ok(input.context.candidate.sources.some((entry) => entry.path === `nested/${filename}`));
  assert.match(input.context.diff, /-export const beforeOddPath = true;/);
  assert.match(input.context.diff, /\+export const afterOddPath = true;/);
});

test("generated output uses the existing schema and rejects unsafe or ambiguous probes", () => {
  assert.ok(probeJsonSchema().properties);
  const parsed = parseGeneratedProbes('```json\n' + JSON.stringify({ probes: [probe] }) + '\n```', 5);
  assert.equal(parsed[0]?.candidateOnly, false);
  for (const content of ["not json", JSON.stringify({ probes: [] }), JSON.stringify({ probes: [probe, probe] })]) {
    assert.throws(() => parseGeneratedProbes(content, 5));
  }
  assert.throws(() => parseGeneratedProbes(JSON.stringify({ probes: [probe, { ...probe, id: "another" }] }), 1), /1 to 1/);
  for (const bad of [
    { ...probe, id: "../escape" },
    { ...probe, steps: [{ do: "evaluate", script: "1" }] },
    { ...probe, steps: [{ do: "click", testId: "button" }] },
    ...["//external.example", "/\\external.example", "/\n/external.example"].map((url) => ({ ...probe, steps: [{ do: "goto", path: url }] })),
    { ...probe, expect: [{ path: "ui.url", equals: "/", matches: ".*" }] },
    { ...probe, expect: [{ path: "db..orders", equals: 1 }] },
  ]) assert.throws(() => parseGeneratedProbes(JSON.stringify({ probes: [bad] }), 5));
});

test("generation saves loadable probes and provenance without overwriting prior runs", async (t) => {
  const f = await fixture();
  t.after(() => fs.rm(f.dir, { recursive: true, force: true }));
  let calls = 0;
  const fetcher: typeof fetch = async (_url, options) => {
    calls++;
    const body = JSON.parse(options?.body as string);
    assert.match(body.messages[0].content, /candidateOnly=false/);
    assert.equal(JSON.parse(body.messages[1].content).request, "Keep checkout working.");
    return response([probe]);
  };
  const options = { repo: f.repo, app: "app", prompt: "Keep checkout working.", config, out: path.join(f.dir, "output") };
  const result = await generate(options, fetcher);
  assert.equal((await loadProbes([result.probesDir]))[0]?.id, probe.id);
  const saved = await fs.readFile(path.join(options.out, "generation.json"), "utf8");
  assert.doesNotMatch(saved, /test-secret|Authorization/);
  assert.equal(JSON.parse(saved).baseline, f.baseline.commit);
  assert.equal(JSON.parse(saved).usage.total_tokens, 123);
  await assert.rejects(generate(options, fetcher), /already exists/);
  assert.equal(calls, 1);
  assert.equal(await fs.readFile(path.join(options.out, "generation.json"), "utf8"), saved);
});

test("one invalid probe rejects the entire batch and leaves no runnable output", async (t) => {
  const f = await fixture();
  t.after(() => fs.rm(f.dir, { recursive: true, force: true }));
  const out = path.join(f.dir, "output");
  await assert.rejects(generate({ repo: f.repo, app: "app", prompt: "Check it", config, out }, async () =>
    response([probe, { ...probe, id: "invalid", steps: [{ do: "shell", command: "true" }] }]),
  ), /invalid/);
  await assert.rejects(fs.stat(out), { code: "ENOENT" });
  const failureFiles = (await fs.readdir(f.dir)).filter((name) => name.startsWith("output.failed-") && name.endsWith(".json"));
  assert.equal(failureFiles.length, 1);
  const failureFile = path.join(f.dir, failureFiles[0]!);
  const saved = await fs.readFile(failureFile, "utf8");
  assert.equal(JSON.parse(saved).model, "fake-model");
  assert.match(JSON.parse(saved).content, /"do":"shell"/);
  assert.doesNotMatch(saved, /test-secret|Authorization/);
  assert.equal((await fs.stat(failureFile)).mode & 0o777, 0o600);
});

test("missing baseline and invalid generation options fail before any provider call", async (t) => {
  const f = await fixture();
  t.after(() => fs.rm(f.dir, { recursive: true, force: true }));
  const fetcher: typeof fetch = async () => { assert.fail("unexpected provider call"); };
  const options = { repo: f.repo, app: "app", prompt: "Check it", config };
  await assert.rejects(generate({ ...options, count: 0 }, fetcher), /--count/);
  await assert.rejects(generate({ ...options, prompt: " " }, fetcher), /nonempty/);
  await exec("git", ["update-ref", "-d", "refs/counterpatch/baseline"], { cwd: f.repo });
  await assert.rejects(generate(options, fetcher), /No baseline/);
});
