import assert from "node:assert/strict";
import { test } from "node:test";
import { checkModel, complete, modelConfig } from "../../src/model.ts";

const config = modelConfig({ model: "test-model" }, { OPENROUTER_API_KEY: "test-secret" });
const messages = [{ role: "user" as const, content: "Generate probes" }];
const reply = (content: string) => ({
  id: "test-response", model: "actual-model",
  choices: [{ message: { content }, finish_reason: "stop" }],
  usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150, provider_extra: "discard" },
});

test("model configuration supports OpenRouter and Nebius without sharing provider keys", () => {
  assert.equal(config.baseUrl, "https://openrouter.ai/api/v1");
  const nebius = modelConfig({}, {
    COUNTERPATCH_BASE_URL: "https://api.tokenfactory.nebius.com/v1/", COUNTERPATCH_MODEL: "nvidia/test",
    NEBIUS_API_KEY: "nebius-key", OPENROUTER_API_KEY: "wrong-key",
  });
  assert.equal(nebius.baseUrl, "https://api.tokenfactory.nebius.com/v1");
  assert.equal(nebius.apiKey, "nebius-key");
  assert.equal(nebius.model, "nvidia/test");
  assert.throws(() => modelConfig({ model: "test", baseUrl: "https://other.example/v1" }, { OPENROUTER_API_KEY: "private" }), /Set COUNTERPATCH_API_KEY/);
  assert.throws(() => modelConfig({}, { OPENROUTER_API_KEY: "private" }), /Choose a model/);
  for (const baseUrl of ["http://remote.example/v1", "https://key:secret@example.com/v1", "https://example.com/v1?key=secret"]) {
    assert.throws(() => modelConfig({ model: "test", baseUrl }, { COUNTERPATCH_API_KEY: "key" }), /base URL/);
  }
  assert.throws(() => modelConfig({ model: "test" }, { OPENROUTER_API_KEY: "key", COUNTERPATCH_MODEL_TIMEOUT_MS: "0" }), /positive integer/);
});

test("chat client sends the compatible request and returns selected usage metadata", async () => {
  let calls = 0;
  const completion = await complete(config, messages, async (url, options) => {
    calls++;
    assert.equal(url, "https://openrouter.ai/api/v1/chat/completions");
    assert.equal(new Headers(options?.headers).get("Authorization"), "Bearer test-secret");
    assert.equal(options?.redirect, "error");
    assert.ok(options?.signal);
    assert.deepEqual(JSON.parse(options?.body as string), { model: "test-model", messages, stream: false, max_tokens: 8192 });
    return Response.json(reply('{"probes":[]}'));
  });
  assert.equal(calls, 1);
  assert.equal(completion.model, "actual-model");
  assert.equal(completion.responseId, "test-response");
  assert.deepEqual(completion.usage, { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 });
});

test("HTTP errors do not expose provider bodies or retry paid requests", async () => {
  for (const status of [400, 401, 402, 403, 429, 500]) {
    let calls = 0;
    await assert.rejects(complete(config, messages, async () => {
      calls++;
      return new Response("echoed test-secret and private source", { status });
    }), (error: Error) => {
      assert.match(error.message, new RegExp(`HTTP ${status}`));
      assert.doesNotMatch(error.message, /test-secret|private source/);
      return true;
    });
    assert.equal(calls, 1);
  }
});

test("client rejects timeouts, malformed responses, refusals and truncated output", async () => {
  await assert.rejects(complete(config, messages, async () => { throw new DOMException("test-secret", "TimeoutError"); }), /timed out/);
  await assert.rejects(complete(config, messages, async () => new Response("not json")), /invalid JSON/);
  await assert.rejects(complete(config, messages, async () => Response.json({ choices: [] })), /invalid chat-completions/);
  await assert.rejects(complete(config, messages, async () => Response.json(reply(""))), /no content/);
  const truncated = reply("{}");
  truncated.choices[0]!.finish_reason = "length";
  await assert.rejects(complete(config, messages, async () => Response.json(truncated)), /truncated/);
  await assert.rejects(complete(config, messages, async () => Response.json({ choices: [{ message: { content: null, refusal: "declined" } }] })), /declined/);
});

test("model connection check sends only a bounded synthetic request and reports JSON separately", async () => {
  const checked = await checkModel(config, async (_url, options) => {
    const body = JSON.parse(options?.body as string);
    assert.equal(body.max_tokens, 2048);
    assert.deepEqual(body.messages, [
      { role: "system", content: "This is a connection check. Reply with JSON only, without reasoning or Markdown." },
      { role: "user", content: 'Return exactly {"probes": []}. Do not generate any probes.' },
    ]);
    return Response.json(reply('Here is the JSON:\n```json\n{"probes":[]}\n```'));
  });
  assert.equal(checked.connected, true);
  assert.equal(checked.jsonOutput, true);
  assert.equal(checked.model, "actual-model");
  assert.doesNotMatch(JSON.stringify(checked), /test-secret/);

  const nonJson = await checkModel(config, async () => Response.json(reply("Hello!")));
  assert.equal(nonJson.connected, true);
  assert.equal(nonJson.jsonOutput, false);
  await assert.rejects(checkModel(config, async () => new Response("invalid key", { status: 401 })), /HTTP 401/);
  await assert.rejects(checkModel(config, async () => new Response("invalid model", { status: 404 })), /exact model ID/);
});
