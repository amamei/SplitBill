import { describe, it } from "node:test";
import assert from "node:assert/strict";
import Anthropic from "@anthropic-ai/sdk";
import type { LlmConfig } from "../../config.js";
import { DahlApiError } from "../dahl.js";
import { GeminiApiError } from "../gemini.js";
import { createAgentClient, describeLlmError, preflightOpenRouter, providerParams, supportsVision } from "../llm.js";
import {
  createOpenRouterClient,
  OPENROUTER_ATTRIBUTION,
  OpenRouterApiError,
  OpenRouterConnectionError,
  OpenRouterMissingKeyError,
  type OpenRouterClientOptions,
} from "../openrouter.js";
import { runTurn } from "../runner.js";
import { controlSession } from "./helpers.js";

const LLM = { provider: "openrouter", model: "anthropic/claude-opus-5.5", baseURL: "https://openrouter.test/api/v1" } as const satisfies LlmConfig;
const KEY = "sk-or-v1-test-key-0123456789";
const enc = new TextEncoder();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

function fakeFetch(...handlers: Array<() => Response>) {
  const calls: Array<{ url: string; init: RequestInit; body: Any }> = [];
  const impl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {}, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return handlers[Math.min(calls.length - 1, handlers.length - 1)]();
  }) as typeof fetch;
  return { impl, calls };
}

const sse = (...events: unknown[]) => events.map((e) => `data: ${JSON.stringify(e)}\n\n`).concat(["data: [DONE]\n\n"]);
const ok = (parts: string[]) => () =>
  new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const part of parts) controller.enqueue(enc.encode(part));
        controller.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
const failure = (status: number, body: unknown) => () => new Response(JSON.stringify(body), { status });

const text = (t: string) => ({ choices: [{ index: 0, delta: { role: "assistant", content: t }, finish_reason: null }] });
const finish = (reason: string, usage?: { prompt_tokens: number; completion_tokens: number }) => ({ choices: [{ index: 0, delta: {}, finish_reason: reason }], ...(usage ? { usage } : {}) });
const toolCall = (id: string, name: string, args: string) => ({
  choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: args } }] }, finish_reason: null }],
});

const client = (impl: typeof fetch, extra: OpenRouterClientOptions = {}) => createOpenRouterClient(LLM, { apiKey: KEY, fetchImpl: impl, backoffMs: [0, 0], ...extra });

describe("OpenRouter provider seam", () => {
  it("routes openrouter to its own client, with vision and a plain system block", () => {
    assert.equal(typeof (createAgentClient(LLM).beta.messages as Any).toolRunner, "function");
    assert.equal(supportsVision(LLM), true);
    assert.deepEqual(providerParams(LLM, "SYS"), { system: [{ type: "text", text: "SYS" }] });
  });
});

describe("runTurn through the OpenRouter client", () => {
  it("calls a tool, then answers, with the Bearer key and the attribution headers", async () => {
    const { session } = controlSession();
    const { impl, calls } = fakeFetch(
      ok(sse(toolCall("c1", "get_summary", "{}"), finish("tool_calls", { prompt_tokens: 50, completion_tokens: 5 }))),
      ok(sse(text("Итог готов."), finish("stop", { prompt_tokens: 70, completion_tokens: 4 }))),
    );

    const telemetry = await runTurn(session, "покажи итог", { client: client(impl), llm: LLM });

    assert.equal(telemetry.error, undefined);
    assert.equal(telemetry.iterations, 2);
    assert.equal(telemetry.model, LLM.model);
    assert.equal(calls[0].url, "https://openrouter.test/api/v1/chat/completions");
    const headers = calls[0].init.headers as Record<string, string>;
    assert.equal(headers.authorization, `Bearer ${KEY}`);
    assert.equal(headers["HTTP-Referer"], OPENROUTER_ATTRIBUTION["HTTP-Referer"]);
    assert.equal(headers["X-Title"], OPENROUTER_ATTRIBUTION["X-Title"]);
    assert.equal(calls[0].body.model, "anthropic/claude-opus-5.5");
    assert.equal(calls[0].body.stream, true);
    assert.deepEqual(calls[0].body.stream_options, { include_usage: true });
    assert.ok(calls[0].body.tools.length > 0);
    const second = calls[1].body.messages;
    assert.deepEqual(second.at(-2).tool_calls[0].function, { name: "get_summary", arguments: "{}" });
    assert.equal(second.at(-1).role, "tool");
    assert.deepEqual(
      session.messages.map((m) => m.role),
      ["user", "assistant", "user", "assistant"],
    );
  });

  it("ignores OpenRouter's keep-alive SSE comments", async () => {
    const { session } = controlSession();
    const { impl } = fakeFetch(ok([": OPENROUTER PROCESSING\n\n", ": OPENROUTER PROCESSING\n\n", ...sse(text("Готово."), finish("stop"))]));
    const telemetry = await runTurn(session, "привет", { client: client(impl), llm: LLM });
    assert.equal(telemetry.error, undefined);
    assert.deepEqual(session.messages.at(-1)?.content, [{ type: "text", text: "Готово." }]);
  });

  it("sends a receipt photo as an image_url data URL next to the text", async () => {
    const { session } = controlSession();
    const { impl, calls } = fakeFetch(ok(sse(text("Вижу чек."), finish("stop"))));
    const content = [
      { type: "image" as const, source: { type: "base64" as const, media_type: "image/png" as const, data: "iVBORw0KGgo=" } },
      { type: "text" as const, text: "Распознай чек" },
    ];

    const telemetry = await runTurn(session, content, { client: client(impl), llm: LLM, kind: "upload" });

    assert.equal(telemetry.error, undefined);
    const user = calls[0].body.messages.find((m: Any) => Array.isArray(m.content));
    assert.ok(user, "the user message with the photo is a parts array");
    assert.deepEqual(user.content.at(-2), { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgo=" } });
    assert.deepEqual(user.content.at(-1), { type: "text", text: "Распознай чек" });
  });

  it("fails with a Russian missing-key message and makes no request", async () => {
    const { session } = controlSession();
    const { impl, calls } = fakeFetch(ok(sse(text("x"), finish("stop"))));
    const telemetry = await runTurn(session, "привет", { client: client(impl, { apiKey: undefined }), llm: LLM });
    assert.equal(calls.length, 0);
    assert.match(String(telemetry.error), /OPENROUTER_API_KEY/);
    assert.equal(session.messages.length, 0, "history rolled back");
  });
});

describe("OpenRouter client errors", () => {
  const drain = async (c: Pick<Anthropic, "beta">) => {
    const runner = (c.beta.messages as Any).toolRunner({ model: LLM.model, max_tokens: 100, messages: [{ role: "user", content: "hi" }], tools: [] });
    for await (const stream of runner) await stream.finalMessage();
  };

  it("raises OpenRouterApiError with OpenRouter's message on 402, never leaking the key", async () => {
    const err = await drain(client(fakeFetch(failure(402, { error: { code: 402, message: `Insufficient credits (${KEY})` } })).impl)).catch((e: unknown) => e);
    assert.ok(err instanceof OpenRouterApiError);
    assert.equal(err.status, 402);
    assert.match(err.message, /Insufficient credits/);
    assert.doesNotMatch(err.message + err.body, new RegExp(KEY));
    assert.equal(err instanceof DahlApiError || err instanceof GeminiApiError, false);
  });

  it("turns a mid-stream error chunk into OpenRouterApiError with its code", async () => {
    const chunk = { error: { code: 502, message: "Provider returned error" }, choices: [{ index: 0, delta: {}, finish_reason: "error" }] };
    const err = await drain(client(fakeFetch(ok(sse(text("Начинаю…"), chunk))).impl)).catch((e: unknown) => e);
    assert.ok(err instanceof OpenRouterApiError);
    assert.equal(err.status, 502);
    assert.match(err.message, /Provider returned error/);
  });

  it("retries a 503 and gives up with OpenRouterApiError after the backoff", async () => {
    const { impl, calls } = fakeFetch(failure(503, { error: { code: 503, message: "No available provider" } }));
    await assert.rejects(drain(client(impl)), (e: unknown) => e instanceof OpenRouterApiError && e.status === 503);
    assert.equal(calls.length, 3);
  });

  it("wraps a network failure in OpenRouterConnectionError", async () => {
    const impl = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    await assert.rejects(drain(client(impl, { backoffMs: [] })), OpenRouterConnectionError);
  });
});

describe("describeLlmError for OpenRouter", () => {
  it("explains the common failures in Russian", () => {
    assert.match(describeLlmError(new OpenRouterMissingKeyError(), LLM), /Не задан OPENROUTER_API_KEY/);
    assert.match(describeLlmError(new OpenRouterApiError(401, "No auth credentials found"), LLM), /не принял ключ \(401\).*OPENROUTER_API_KEY/);
    assert.match(describeLlmError(new OpenRouterApiError(402, "Insufficient credits"), LLM), /закончились кредиты \(402\)/);
    assert.match(describeLlmError(new OpenRouterApiError(403, "flagged"), LLM), /модерацией \(403\): flagged/);
    assert.match(describeLlmError(new OpenRouterApiError(404, "No endpoints found"), LLM), /claude-opus-5\.5 не найдена.*OPENROUTER_MODEL/);
    assert.match(describeLlmError(new OpenRouterApiError(400, "No endpoints found that support tool use"), LLM), /не поддерживает инструменты или изображения/);
    assert.equal(describeLlmError(new OpenRouterApiError(400, "bad field"), LLM), "Некорректный запрос к OpenRouter: bad field");
    assert.match(describeLlmError(new OpenRouterApiError(408, "timeout"), LLM), /не дождался.*408/);
    assert.match(describeLlmError(new OpenRouterApiError(429, "rate"), LLM), /Слишком много запросов к OpenRouter \(429\)/);
    assert.match(describeLlmError(new OpenRouterApiError(502, "x"), LLM), /недоступен \(502\)/);
    assert.match(describeLlmError(new OpenRouterConnectionError("ECONNREFUSED"), LLM), /openrouter\.test.*ECONNREFUSED/);
  });

  it("keeps OpenRouter texts apart from the other providers", () => {
    assert.doesNotMatch(describeLlmError(new GeminiApiError(401, "x"), LLM), /OPENROUTER_API_KEY/);
    assert.doesNotMatch(describeLlmError(new OpenRouterApiError(401, "x"), { provider: "gemini", model: "m", baseURL: "https://g" }), /OPENROUTER/);
  });
});

describe("preflightOpenRouter", () => {
  const listed = (extra: Record<string, unknown> = {}) => ({
    data: [
      { id: "google/gemini-2.5-flash", supported_parameters: ["tools"], architecture: { input_modalities: ["text", "image"] } },
      { id: LLM.model, supported_parameters: ["max_tokens", "tools"], architecture: { input_modalities: ["text", "image", "file"] }, ...extra },
    ],
  });
  /** /models and /key answer from their own scripted replies. */
  const server = (models: { status: number; body?: unknown }, key: { status: number; body?: unknown } = { status: 200, body: { data: { limit_remaining: 12.5, is_free_tier: false } } }) => {
    const calls: Array<{ url: string; auth?: string }> = [];
    const impl = async (url: string, init: RequestInit) => {
      calls.push({ url, auth: (init.headers as Record<string, string> | undefined)?.authorization });
      const reply = url.endsWith("/key") ? key : models;
      return { ok: reply.status < 400, status: reply.status, json: async () => reply.body ?? {} };
    };
    return { impl, calls };
  };

  it("finds the model with tools and vision in the public list and checks the key", async () => {
    const { impl, calls } = server({ status: 200, body: listed() });
    const r = await preflightOpenRouter(LLM, { apiKey: KEY, fetchImpl: impl });
    assert.deepEqual(r.warnings, []);
    assert.deepEqual({ reachable: r.reachable, modelListed: r.modelListed, tools: r.tools, vision: r.vision, keyAccepted: r.keyAccepted }, { reachable: true, modelListed: true, tools: true, vision: true, keyAccepted: true });
    assert.equal(calls[0].url, "https://openrouter.test/api/v1/models");
    assert.equal(calls[0].auth, undefined, "the model list is public");
    assert.equal(calls[1].url, "https://openrouter.test/api/v1/key");
    assert.equal(calls[1].auth, `Bearer ${KEY}`);
  });

  it("warns about a model without image input or without tools", async () => {
    const noVision = await preflightOpenRouter(LLM, { apiKey: KEY, fetchImpl: server({ status: 200, body: listed({ architecture: { input_modalities: ["text"] } }) }).impl });
    assert.equal(noVision.vision, false);
    assert.match(noVision.warnings.join("\n"), /без vision/);

    const noTools = await preflightOpenRouter(LLM, { apiKey: KEY, fetchImpl: server({ status: 200, body: listed({ supported_parameters: ["max_tokens"] }) }).impl });
    assert.equal(noTools.tools, false);
    assert.match(noTools.warnings.join("\n"), /без tools/);
  });

  it("warns about a missing key without calling /key, and about a rejected key", async () => {
    const none = server({ status: 200, body: listed() });
    const missing = await preflightOpenRouter(LLM, { apiKey: undefined, fetchImpl: none.impl });
    assert.match(missing.warnings[0], /OPENROUTER_API_KEY не задан/);
    assert.equal(none.calls.some((c) => c.url.endsWith("/key")), false);

    const rejected = await preflightOpenRouter(LLM, { apiKey: KEY, fetchImpl: server({ status: 200, body: listed() }, { status: 401 }).impl });
    assert.equal(rejected.keyAccepted, false);
    assert.match(rejected.warnings.join("\n"), /не принял OPENROUTER_API_KEY \(401\)/);
  });

  it("names a model missing from the list, survives an unreachable host, and never logs the key", async () => {
    const r = await preflightOpenRouter({ ...LLM, model: "nope/nope" }, { apiKey: KEY, fetchImpl: server({ status: 200, body: listed() }).impl });
    assert.equal(r.modelListed, false);
    assert.equal(r.tools, null);
    assert.match(r.warnings[0], /nope\/nope нет в OpenRouter \/models.*OPENROUTER_MODEL/);

    const down = await preflightOpenRouter(LLM, {
      apiKey: KEY,
      fetchImpl: async () => {
        throw new TypeError("fetch failed");
      },
    });
    assert.equal(down.reachable, false);
    assert.equal(down.keyAccepted, null);
    assert.match(down.warnings[0], /OpenRouter недоступен/);
    for (const warning of [...r.warnings, ...down.warnings]) assert.doesNotMatch(warning, new RegExp(KEY));
  });
});
