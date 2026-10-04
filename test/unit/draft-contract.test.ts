import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { contentHash } from "../../src/bundle.ts";
import { draftContract, parseContractDraft } from "../../src/draft-contract.ts";
import { exec } from "../../src/exec.ts";
import { onPrompt, readTask } from "../../src/hooks.ts";
import { loadContract } from "../../src/contract.ts";
import { modelConfig } from "../../src/model.ts";
import { readBaseline } from "../../src/snapshot.ts";

const prompt = "Add percentage coupons. Keep guest checkout available.";
const contract = { schemaVersion: 1, title: "Add coupons", requirements: [
  { id: "coupons", kind: "change", description: "Percentage coupons discount the order total" },
  { id: "guest-checkout", kind: "preserve", description: "Guest checkout stays available" },
], exclusions: [] };
const draft = { contract, basis: [
  { requirementId: "coupons", quotes: [{ promptIndex: 1, quote: "Add percentage coupons." }] },
  { requirementId: "guest-checkout", quotes: [{ promptIndex: 1, quote: "Keep guest checkout available." }] },
], questions: [] };
const config = modelConfig({ model: "test-model" }, { OPENROUTER_API_KEY: "test-private-key" });
const response = (answer: unknown) => Response.json({ model: "test-model", id: "response", choices: [
  { message: { content: JSON.stringify(answer) }, finish_reason: "stop" },
], usage: { total_tokens: 50 } });

async function fixture(t: TestContext) {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "counterpatch-draft-")));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const repo = path.join(dir, "repo");
  await fs.mkdir(repo);
  await exec("git", ["init", "--quiet"], { cwd: repo });
  await fs.writeFile(path.join(repo, "page.ts"), "Do not transmit this source to contract drafting");
  return { dir, repo, options: { repo, config, out: path.join(dir, "draft") } };
}

test("drafts accept presentation wrappers and enforce a quoted basis for every requirement", () => {
  const json = JSON.stringify(draft);
  assert.deepEqual(parseContractDraft(`<think>Extract intent.</think>\nHere:\n\`\`\`json\n${json}\n\`\`\``, [prompt]), draft);
  const invalid = [
    { ...draft, basis: draft.basis.slice(0, 1) },
    { ...draft, basis: [...draft.basis, draft.basis[0]] },
    { ...draft, basis: [{ requirementId: "unknown", quotes: [{ promptIndex: 1, quote: "coupons" }] }] },
    { ...draft, basis: [{ ...draft.basis[0], quotes: [{ promptIndex: 2, quote: "coupons" }] }, draft.basis[1]] },
    { ...draft, basis: [{ ...draft.basis[0], quotes: [{ promptIndex: 1, quote: "Invented permission" }] }, draft.basis[1]] },
    { ...draft, contract: { ...contract, requirements: [contract.requirements[0], contract.requirements[0]] } },
    { ...draft, unexpected: true },
  ];
  for (const answer of invalid) assert.throws(() => parseContractDraft(JSON.stringify(answer), [prompt]));
  assert.throws(() => parseContractDraft(`One:\n${json}\nTwo:\n${json}`, [prompt]), /ambiguous/);
  assert.throws(() => parseContractDraft(`<think>${json}`, [prompt]), /unfinished/);
});

test("an ambiguous request can produce questions without inventing requirements", () => {
  const questions = { contract: null, basis: [], questions: ["Which checkout behavior should change?"] };
  assert.deepEqual(parseContractDraft(JSON.stringify(questions), ["Fix it"]), questions);
  assert.throws(() => parseContractDraft(JSON.stringify({ ...questions, questions: [] }), ["Fix it"]), /must contain questions/);
  assert.throws(() => parseContractDraft(JSON.stringify({ ...questions, basis: draft.basis }), [prompt]), /no requirement basis/);
});

test("explicit drafts save private review artifacts without reading source or replacing an existing output", async (t) => {
  const { repo, options } = await fixture(t);
  let calls = 0;
  const provider: typeof fetch = async (_url, init) => {
    calls++;
    const body = JSON.parse(init!.body as string);
    assert.deepEqual(JSON.parse(body.messages[1].content), { prompts: [{ index: 1, text: prompt }] });
    assert.doesNotMatch(JSON.stringify(body), /Do not transmit this source|test-private-key|sessionId/);
    assert.match(body.messages[0].content, /Later explicit\s+corrections supersede/);
    return response(draft);
  };
  const result = await draftContract({ ...options, prompt }, provider);
  assert.equal(result.metadata.status, "draft");
  assert.equal(result.metadata.contractHash, contentHash(draft.contract));
  assert.ok(result.contractFile);
  assert.deepEqual(await loadContract(result.contractFile), draft.contract);
  const request = JSON.parse(await fs.readFile(path.join(result.out, "request.json"), "utf8"));
  assert.equal(result.metadata.requestHash, contentHash(request));
  assert.doesNotMatch(JSON.stringify(result.metadata), /test-private-key/);
  assert.equal((await fs.stat(result.contractFile)).mode & 0o777, 0o600);
  assert.equal(await readBaseline(repo), null, "drafting must not create or move the baseline");
  assert.equal((await exec("git", ["ls-files"], { cwd: repo })).stdout, "");
  await assert.rejects(draftContract({ ...options, prompt }, provider), /already exists/);
  assert.equal(calls, 1);
});

test("captured drafting uses only the open task's ordered prompts and retains task identity locally", async (t) => {
  const { repo, options } = await fixture(t);
  await onPrompt(repo, { session_id: "old-session", prompt: "Unrelated old request" });
  await onPrompt(repo, { session_id: "current-session", prompt });
  const correction = "Correction: require login at checkout.";
  await onPrompt(repo, { session_id: "current-session", prompt: correction });
  const originalTask = await readTask(repo);
  const originalBaseline = await readBaseline(repo);
  const corrected = { ...draft, contract: { ...contract, requirements: [contract.requirements[0],
    { id: "checkout-login", kind: "change", description: "Checkout requires login" }] }, basis: [draft.basis[0],
    { requirementId: "checkout-login", quotes: [{ promptIndex: 2, quote: correction }] }] };
  const result = await draftContract({ ...options, fromTask: true }, async (_url, init) => {
    const user = JSON.parse(JSON.parse(init!.body as string).messages[1].content);
    assert.deepEqual(user.prompts.map((p: { text: string }) => p.text), [prompt, correction]);
    assert.doesNotMatch(JSON.stringify(user), /old-session|current-session|Unrelated old request|Do not transmit this source/);
    return response(corrected);
  });
  assert.equal(result.metadata.status, "draft");
  assert.deepEqual(result.metadata.task, originalTask);
  assert.deepEqual(await readTask(repo), originalTask);
  assert.deepEqual(await readBaseline(repo), originalBaseline);
  assert.equal(result.draft.contract?.requirements[1]?.kind, "change");
});

test("a follow-up arriving during the model request marks its draft stale without changing the task", async (t) => {
  const { repo, options } = await fixture(t);
  await onPrompt(repo, { session_id: "session", prompt });
  const result = await draftContract({ ...options, fromTask: true }, async () => {
    await onPrompt(repo, { session_id: "session", prompt: "Actually require login at checkout." });
    return response(draft);
  });
  assert.equal(result.metadata.status, "stale");
  assert.equal(result.metadata.taskChangedWhileDrafting, true);
  assert.notEqual((await readTask(repo))?.revision, result.metadata.task?.revision);
  assert.ok(await fs.stat(path.join(result.out, "draft.json")));
});

test("questions are saved as unresolved and never create an empty contract file", async (t) => {
  const { options } = await fixture(t);
  const result = await draftContract({ ...options, prompt: "Fix it" }, async () => response({
    contract: null, basis: [], questions: ["What should the app do differently?"],
  }));
  assert.equal(result.metadata.status, "needs-clarification");
  assert.equal(result.contractFile, null);
  await assert.rejects(fs.stat(path.join(result.out, "contract.json")), { code: "ENOENT" });
});

test("invalid inputs fail before provider calls and rejected model output leaves no usable draft", async (t) => {
  const { options } = await fixture(t);
  let calls = 0;
  const provider: typeof fetch = async () => { calls++; return response({ ...draft, basis: [] }); };
  for (const extra of [{}, { prompt, fromTask: true }, { prompt: " " }, { fromTask: true }, { prompt: "x".repeat(50_001) }]) {
    await assert.rejects(draftContract({ ...options, ...extra }, provider));
  }
  assert.equal(calls, 0);
  await assert.rejects(draftContract({ ...options, prompt }, provider), /supporting quotes/);
  assert.equal(calls, 1);
  await assert.rejects(fs.stat(options.out), { code: "ENOENT" });
});

test("cancelling the model request removes the reserved draft directory", async (t) => {
  const { options } = await fixture(t);
  const controller = new AbortController();
  await assert.rejects(draftContract({ ...options, prompt, signal: controller.signal }, async (_url, init) => {
    controller.abort();
    init!.signal!.throwIfAborted();
    return response(draft);
  }), /cancelled/);
  await assert.rejects(fs.stat(options.out), { code: "ENOENT" });
});
