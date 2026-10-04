import { z } from "zod";
import { parseModelOutput } from "./model-output.ts";

export type ModelConfig = { baseUrl: string; apiKey: string; model: string; timeoutMs: number; maxTokens: number };
export type ModelMessage = { role: "system" | "user"; content: string };

export function modelConfig(
  options: { baseUrl?: string; model?: string } = {},
  env: NodeJS.ProcessEnv = process.env,
): ModelConfig {
  const url = new URL(options.baseUrl ?? env.COUNTERPATCH_BASE_URL ?? "https://openrouter.ai/api/v1");
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && local)) || url.username || url.password || url.search || url.hash) {
    throw new Error("Model base URL must use HTTPS (HTTP is allowed for localhost), without credentials, a query, or a fragment.");
  }
  const providerKey = url.hostname === "openrouter.ai" ? env.OPENROUTER_API_KEY
    : url.hostname === "api.tokenfactory.nebius.com" ? env.NEBIUS_API_KEY : undefined;
  const apiKey = (env.COUNTERPATCH_API_KEY ?? providerKey)?.trim();
  if (!apiKey) throw new Error("Set COUNTERPATCH_API_KEY, or OPENROUTER_API_KEY / NEBIUS_API_KEY for that provider.");
  const model = (options.model ?? env.COUNTERPATCH_MODEL)?.trim();
  if (!model) throw new Error("Choose a model with --model <provider-model-id> or COUNTERPATCH_MODEL.");
  const positive = (name: string, fallback: number) => {
    const value = Number(env[name] ?? fallback);
    if (!Number.isSafeInteger(value) || value <= 0 || value > 2_147_483_647) throw new Error(`${name} must be a positive integer below 2147483648.`);
    return value;
  };
  return {
    baseUrl: url.href.replace(/\/+$/, ""), apiKey, model,
    timeoutMs: positive("COUNTERPATCH_MODEL_TIMEOUT_MS", 120_000),
    maxTokens: positive("COUNTERPATCH_MAX_TOKENS", 8192),
  };
}

const CompletionSchema = z.object({
  id: z.string().optional(),
  model: z.string().optional(),
  choices: z.array(z.object({
    finish_reason: z.string().nullable().optional(),
    message: z.object({ content: z.string().nullable(), refusal: z.string().nullable().optional() }),
  })).min(1),
  usage: z.object({
    prompt_tokens: z.number().nonnegative().optional(),
    completion_tokens: z.number().nonnegative().optional(),
    total_tokens: z.number().nonnegative().optional(),
  }).optional(),
});

// The client sends a single bounded request without automatic retries.
export async function complete(config: ModelConfig, messages: ModelMessage[], fetchImpl: typeof fetch = fetch, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const started = Date.now();
  let response: Response;
  let payload: unknown;
  try {
    response = await fetchImpl(`${config.baseUrl}/chat/completions`, {
      method: "POST",
      redirect: "error",
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(config.timeoutMs)]) : AbortSignal.timeout(config.timeoutMs),
      headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: config.model, messages, stream: false, max_tokens: config.maxTokens }),
    });
    if (response.ok) payload = await response.json();
  } catch (error) {
    if (signal?.aborted) throw new Error("Model request was cancelled.");
    if (error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name)) {
      throw new Error(`Model request timed out after ${config.timeoutMs} ms. Adjust COUNTERPATCH_MODEL_TIMEOUT_MS if needed.`);
    }
    // Provider responses and transport errors can contain echoed credentials
    // or source code. Keep them out of terminal output and saved metadata.
    throw new Error("Model request failed or returned invalid JSON. Check the endpoint and connection.");
  }
  if (!response.ok) {
    const hint = response.status === 401 || response.status === 403 ? "Check your API key and model access."
      : response.status === 402 ? "Check your provider credits."
      : response.status === 429 ? "Rate limited; retry later."
      : response.status === 404 ? "Model or endpoint not found. Check the exact model ID and base URL."
      : "Check the model ID, endpoint, and provider availability.";
    throw new Error(`Model request failed (HTTP ${response.status}). ${hint}`);
  }
  const parsed = CompletionSchema.safeParse(payload);
  if (!parsed.success) throw new Error("Model returned an invalid chat-completions response.");
  const choice = parsed.data.choices[0]!;
  if (choice.finish_reason === "length") throw new Error("Model output was truncated. Increase COUNTERPATCH_MAX_TOKENS or reduce the requested output.");
  if (choice.message.refusal || choice.finish_reason === "content_filter") throw new Error("Model declined the request.");
  if (!choice.message.content?.trim()) throw new Error("Model returned no content.");
  return {
    content: choice.message.content,
    model: parsed.data.model ?? config.model,
    responseId: parsed.data.id,
    usage: parsed.data.usage ?? null,
    durationMs: Date.now() - started,
  };
}

// This sends only a fixed synthetic message: no repository, prompt history,
// manifest, or source files are needed to test authentication and model access.
export async function checkModel(config: ModelConfig, fetchImpl: typeof fetch = fetch) {
  const completion = await complete({ ...config, maxTokens: Math.min(config.maxTokens, 2048) }, [
    { role: "system", content: "This is a connection check. Reply with JSON only, without reasoning or Markdown." },
    { role: "user", content: 'Return exactly {"probes": []}. Do not generate any probes.' },
  ], fetchImpl);
  let jsonOutput = false;
  try {
    jsonOutput = z.strictObject({ probes: z.array(z.unknown()).length(0) }).safeParse(parseModelOutput(completion.content)).success;
  } catch { /* Authentication succeeded, but the output needs separate attention. */ }
  return {
    connected: true as const, baseUrl: config.baseUrl, requestedModel: config.model,
    model: completion.model, jsonOutput, durationMs: completion.durationMs, usage: completion.usage,
  };
}
