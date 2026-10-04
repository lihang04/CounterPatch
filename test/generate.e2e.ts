// Exercises the CLI and real HTTP transport against a local provider double.
// No provider credentials or paid model requests are needed.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { exec, ExecError } from "../src/exec.ts";
import { loadProbes } from "../src/probe.ts";
import { recordBaseline } from "../src/snapshot.ts";
import { onPrompt, readTask } from "../src/hooks.ts";

const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const probe = { id: "generated-home", title: "Home loads", steps: [{ do: "goto", path: "/" }], expect: [{ path: "ui.url", equals: "/" }] };

async function main() {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "counterpatch-generate-e2e-")));
  const repo = path.join(dir, "repo");
  let requests = 0;
  let servedProbe: unknown = probe;
  const draftRequest = "Keep home available.";
  const draftAnswer = { contract: { schemaVersion: 1, title: "Keep home available", requirements: [
    { id: "home", kind: "preserve", description: "Home remains available" },
  ], exclusions: [] }, basis: [{ requirementId: "home", quotes: [{ promptIndex: 1, quote: draftRequest }] }], questions: [] };
  let servedDraft: unknown = draftAnswer;
  let requestBody: { model?: string; messages: { content: string }[] } = { messages: [] };
  let serverError: unknown;
  const server = http.createServer(async (request, response) => {
    try {
      assert.equal(request.url, "/v1/chat/completions");
      assert.equal(request.headers.authorization, "Bearer local-test-key");
      let body = "";
      for await (const chunk of request) body += chunk;
      requestBody = JSON.parse(body);
      requests++;
      const system = requestBody.messages[0]?.content ?? "";
      const answer = system.includes("You draft reviewable task contracts") ? servedDraft
        : { probes: system.includes("connection check") ? [] : [servedProbe] };
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({
        id: "local-response", model: "test-model",
        choices: [{ message: { content: `<think>Prepare the answer.</think>\nHere is the answer:\n\`\`\`json\n${JSON.stringify(answer)}\n\`\`\`` }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
      }));
    } catch (error) {
      serverError = error;
      response.writeHead(500).end();
    }
  });
  try {
    await fs.mkdir(repo);
    await exec("git", ["init", "--quiet"], { cwd: repo });
    await fs.writeFile(path.join(repo, "counterpatch.manifest.json"), JSON.stringify({
      name: "fixture", framework: "nextjs", commands: { install: "true", start: "true", resetDatabase: "true" },
      readiness: { path: "/" }, network: { include: ["/api/"] }, database: { observables: {} },
    }));
    await fs.writeFile(path.join(repo, "page.tsx"), '<p data-testid="before">Before</p>');
    const baseline = await recordBaseline(repo);
    await fs.writeFile(path.join(repo, "page.tsx"), '<p data-testid="after">After</p>');
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const env = {
      ...process.env, COUNTERPATCH_API_KEY: "local-test-key", COUNTERPATCH_MODEL: "test-model",
      COUNTERPATCH_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
      COUNTERPATCH_MODEL_TIMEOUT_MS: "10000", COUNTERPATCH_MAX_TOKENS: "8192",
    };
    const run = (out: string) => exec(process.execPath, ["--import", "tsx", cli, "generate", "--repo", repo,
      "--prompt", "Preserve home", "--out", out, "--count", "2", "--json"], { env });
    const out = path.join(dir, "output");
    const { stdout } = await run(out);
    const generated = JSON.parse(stdout);
    assert.equal(generated.metadata.baseline, baseline.commit);
    assert.equal(generated.metadata.usage.total_tokens, 30);
    assert.equal((await loadProbes([generated.probesDir]))[0]?.id, probe.id);
    assert.equal(requestBody.model, "test-model");
    assert.equal(JSON.parse(requestBody.messages[1]!.content).request, "Preserve home");
    assert.doesNotMatch(stdout, /local-test-key/);
    await assert.rejects(run(out), (error: unknown) => error instanceof ExecError && error.code === 2 && /already exists/.test(error.stderr));
    assert.equal(requests, 1);
    servedProbe = { ...probe, expect: [] };
    const invalid = path.join(dir, "invalid");
    await assert.rejects(run(invalid), (error: unknown) => error instanceof ExecError && error.code === 2);
    await assert.rejects(fs.stat(invalid), { code: "ENOENT" });
    const settings = path.join(dir, ".env");
    await fs.writeFile(settings, `COUNTERPATCH_API_KEY=local-test-key\nCOUNTERPATCH_MODEL=test-model\nCOUNTERPATCH_BASE_URL=http://127.0.0.1:${address.port}/v1\n`, { mode: 0o600 });
    const checked = await exec(process.execPath, ["--import", "tsx", cli, "check-model", "--repo", dir, "--env-file", settings, "--json"], {
      env: { ...env, COUNTERPATCH_API_KEY: "wrong-shell-key", COUNTERPATCH_MODEL: "wrong-shell-model" },
    });
    assert.equal(JSON.parse(checked.stdout).connected, true);
    assert.equal(JSON.parse(checked.stdout).jsonOutput, true);
    assert.doesNotMatch(checked.stdout + checked.stderr, /local-test-key|wrong-shell-key/);
    const contract = { schemaVersion: 1, title: "Keep home available", requirements: [
      { id: "home", kind: "preserve", description: "Home remains available" },
    ], exclusions: [] };
    const contractPath = path.join(dir, "contract.json");
    await fs.writeFile(contractPath, JSON.stringify(contract));
    servedProbe = { ...probe, requirementId: "home" };
    const contracted = await exec(process.execPath, ["--import", "tsx", cli, "generate", "--repo", repo,
      "--contract", contractPath, "--out", path.join(dir, "contracted"), "--json"], { env });
    const withContract = JSON.parse(contracted.stdout);
    assert.deepEqual(JSON.parse(requestBody.messages[1]!.content).taskContract, contract);
    assert.deepEqual(JSON.parse(await fs.readFile(withContract.contractFile, "utf8")), contract);
    assert.equal((await loadProbes([withContract.probesDir]))[0]?.requirementId, "home");
    // Linked probes cannot silently fall back to differential-only verification.
    await assert.rejects(exec(process.execPath, ["--import", "tsx", cli, "verify", "--repo", repo,
      "--probes", withContract.probesDir], { env }), (error: unknown) => error instanceof ExecError && /supply --contract/.test(error.stderr));
    const draftOut = path.join(dir, "draft");
    const drafted = await exec(process.execPath, ["--import", "tsx", cli, "draft-contract", "--repo", repo,
      "--prompt", draftRequest, "--out", draftOut, "--env-file", settings,
      "--model", "explicit-draft-model", "--base-url", env.COUNTERPATCH_BASE_URL], { env });
    assert.match(drafted.stdout, /preserve \[home\]/);
    assert.match(drafted.stdout, /Prompt 1: "Keep home available\."/);
    assert.match(drafted.stdout, /After review:.*generate .*--contract.*--env-file/);
    assert.match(drafted.stdout, /--model 'explicit-draft-model'.*--base-url/);
    assert.equal(requestBody.model, "explicit-draft-model");
    assert.doesNotMatch(drafted.stdout + drafted.stderr, /local-test-key/);
    assert.deepEqual(JSON.parse(requestBody.messages[1]!.content), { prompts: [{ index: 1, text: draftRequest }] });
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(draftOut, "contract.json"), "utf8")), draftAnswer.contract);
    // Selecting the reviewed draft feeds the existing generation flow.
    const selected = await exec(process.execPath, ["--import", "tsx", cli, "generate", "--repo", repo,
      "--contract", path.join(draftOut, "contract.json"), "--out", path.join(dir, "selected-draft"), "--json"], { env });
    assert.equal(JSON.parse(selected.stdout).metadata.contractHash, JSON.parse(await fs.readFile(path.join(draftOut, "metadata.json"), "utf8")).contractHash);
    const callsBeforeDuplicate = requests;
    await assert.rejects(exec(process.execPath, ["--import", "tsx", cli, "draft-contract", "--repo", repo,
      "--prompt", draftRequest, "--out", draftOut], { env }), (error: unknown) => error instanceof ExecError && error.code === 2);
    assert.equal(requests, callsBeforeDuplicate);
    servedDraft = { contract: null, basis: [], questions: ["What behavior should change?"] };
    await assert.rejects(exec(process.execPath, ["--import", "tsx", cli, "draft-contract", "--repo", repo,
      "--prompt", "Fix it", "--out", path.join(dir, "questions"), "--json"], { env }), (error: unknown) => {
      assert.ok(error instanceof ExecError);
      assert.equal(error.code, 3);
      assert.equal(JSON.parse(error.stdout).metadata.status, "needs-clarification");
      return true;
    });
    servedDraft = draftAnswer;
    await onPrompt(repo, { session_id: "draft-task", prompt: draftRequest });
    const task = await readTask(repo);
    const captured = await exec(process.execPath, ["--import", "tsx", cli, "draft-contract", "--repo", repo,
      "--from-task", "--out", path.join(dir, "captured"), "--json"], { env });
    assert.equal(JSON.parse(captured.stdout).metadata.task.revision, task?.revision);
    assert.deepEqual(JSON.parse(requestBody.messages[1]!.content), { prompts: [{ index: 1, text: draftRequest }] });
    assert.equal(serverError, undefined);
    console.log("generate e2e: PASS (local mock provider)");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(dir, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
