import { describe, it } from "node:test";
import assert from "node:assert/strict";
import Anthropic from "@anthropic-ai/sdk";
import type { LlmConfig } from "../../config.js";
import { DahlApiError } from "../dahl.js";
import { createGeminiClient, GeminiApiError, GeminiConnectionError, GeminiMissingKeyError, type GeminiClientOptions } from "../gemini.js";
import { createAgentClient, describeLlmError, preflightGemini, providerParams, supportsVision } from "../llm.js";
import { runTurn } from "../runner.js";
import { controlSession } from "./helpers.js";

const LLM = { provider: "gemini", model: "gemini-2.5-flash", baseURL: "https://gemini.test/v1beta/openai" } as const satisfies LlmConfig;
const KEY = "gemini-test-key-0123456789";
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

const client = (impl: typeof fetch, extra: GeminiClientOptions = {}) => createGeminiClient(LLM, { apiKey: KEY, fetchImpl: impl, backoffMs: [0, 0], ...extra });

describe("Gemini provider seam", () => {
  it("routes gemini to its own client, with vision and a plain system block", () => {
    assert.equal(typeof (createAgentClient(LLM).beta.messages as Any).toolRunner, "function");
    assert.equal(supportsVision(LLM), true);
    assert.deepEqual(providerParams(LLM, "SYS"), { system: [{ type: "text", text: "SYS" }] });
  });
});

describe("runTurn through the Gemini client", () => {
  it("calls a tool, then answers, against the OpenAI-compatible endpoint with the Bearer key", async () => {
    const { session } = controlSession();
    const { impl, calls } = fakeFetch(ok(sse(toolCall("c1", "get_summary", "{}"), finish("tool_calls", { prompt_tokens: 50, completion_tokens: 5 }))), ok(sse(text("Итог готов."), finish("stop", { prompt_tokens: 70, completion_tokens: 4 }))));

    const telemetry = await runTurn(session, "покажи итог", { client: client(impl), llm: LLM });

    assert.equal(telemetry.error, undefined);
    assert.equal(telemetry.iterations, 2);
    assert.equal(telemetry.model, LLM.model);
    assert.equal(calls[0].url, "https://gemini.test/v1beta/openai/chat/completions");
    assert.equal((calls[0].init.headers as Record<string, string>).authorization, `Bearer ${KEY}`);
    assert.equal(calls[0].body.model, "gemini-2.5-flash");
    assert.equal(calls[0].body.stream, true);
    assert.ok(calls[0].body.tools.length > 0);
    const second = calls[1].body.messages;
    assert.deepEqual(second.at(-2).tool_calls[0].function, { name: "get_summary", arguments: "{}" });
    assert.equal(second.at(-1).role, "tool");
    assert.deepEqual(
      session.messages.map((m) => m.role),
      ["user", "assistant", "user", "assistant"],
    );
    assert.equal(session.busy, false);
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
    assert.match(String(telemetry.error), /GEMINI_API_KEY/);
    assert.equal(session.messages.length, 0, "history rolled back");
  });
});

describe("Gemini client errors", () => {
  const drain = async (c: Pick<Anthropic, "beta">) => {
    const runner = (c.beta.messages as Any).toolRunner({ model: LLM.model, max_tokens: 100, messages: [{ role: "user", content: "hi" }], tools: [] });
    for await (const stream of runner) await stream.finalMessage();
  };

  it("raises GeminiApiError with the Google error message, never leaking the key", async () => {
    const body = [{ error: { code: 400, message: `API key not valid. Please pass a valid API key. (${KEY})`, status: "INVALID_ARGUMENT" } }];
    const err = await drain(client(fakeFetch(failure(400, body)).impl)).catch((e: unknown) => e);
    assert.ok(err instanceof GeminiApiError);
    assert.equal(err.status, 400);
    assert.doesNotMatch(err.message + err.body, new RegExp(KEY));
  });

  it("retries a 503 and gives up with GeminiApiError after the backoff", async () => {
    const { impl, calls } = fakeFetch(failure(503, { error: { message: "overloaded" } }));
    await assert.rejects(drain(client(impl)), (e: unknown) => e instanceof GeminiApiError && e.status === 503);
    assert.equal(calls.length, 3);
  });

  it("wraps a network failure in GeminiConnectionError", async () => {
    const impl = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    await assert.rejects(drain(client(impl, { backoffMs: [] })), GeminiConnectionError);
  });
});

describe("describeLlmError for Gemini", () => {
  it("explains the common failures in Russian", () => {
    assert.match(describeLlmError(new GeminiMissingKeyError(), LLM), /Не задан GEMINI_API_KEY/);
    assert.match(describeLlmError(new GeminiApiError(400, "API key not valid. Please pass a valid API key."), LLM), /не принял ключ.*GEMINI_API_KEY/);
    assert.match(describeLlmError(new GeminiApiError(404, "models/nope is not found"), LLM), /gemini-2\.5-flash не найдена.*GEMINI_MODEL/);
    assert.match(describeLlmError(new GeminiApiError(429, "quota"), LLM), /квота.*429/);
    assert.equal(describeLlmError(new GeminiApiError(400, "bad field"), LLM), "Некорректный запрос к Gemini: bad field");
    assert.match(describeLlmError(new GeminiApiError(503, "x"), LLM), /Gemini временно недоступен \(503\)/);
    assert.match(describeLlmError(new GeminiConnectionError("ECONNREFUSED"), LLM), /gemini\.test.*ECONNREFUSED/);
  });

  it("keeps Dahl and Gemini texts apart", () => {
    assert.doesNotMatch(describeLlmError(new DahlApiError(401, "x"), LLM), /DAHL_API_KEY/);
    assert.doesNotMatch(describeLlmError(new GeminiApiError(401, "x"), { provider: "dahl", model: "m", baseURL: "https://d" }), /GEMINI/);
  });
});

describe("preflightGemini", () => {
  const reply = (status: number, body: unknown = {}) => {
    const calls: Array<{ url: string; auth?: string }> = [];
    const impl = async (url: string, init: RequestInit) => {
      calls.push({ url, auth: (init.headers as Record<string, string> | undefined)?.authorization });
      return { ok: status < 400, status, json: async () => body };
    };
    return { impl, calls };
  };

  it("lists models with the key and finds the configured one", async () => {
    const { impl, calls } = reply(200, { data: [{ id: "models/gemini-2.5-flash" }, { id: "models/gemini-2.5-pro" }] });
    const r = await preflightGemini(LLM, { apiKey: KEY, fetchImpl: impl });
    assert.deepEqual(r.warnings, []);
    assert.equal(r.keyAccepted && r.modelListed, true);
    assert.equal(calls[0].url, "https://gemini.test/v1beta/openai/models");
    assert.equal(calls[0].auth, `Bearer ${KEY}`);
  });

  it("warns about a missing key without a request, and about a rejected key", async () => {
    const none = reply(200);
    const missing = await preflightGemini(LLM, { apiKey: undefined, fetchImpl: none.impl });
    assert.match(missing.warnings[0], /GEMINI_API_KEY не задан/);
    assert.equal(none.calls.length, 0);

    const rejected = await preflightGemini(LLM, { apiKey: KEY, fetchImpl: reply(400).impl });
    assert.equal(rejected.keyAccepted, false);
    assert.match(rejected.warnings[0], /не принял GEMINI_API_KEY \(400\)/);
  });

  it("names a model missing from the list, and survives an unreachable host", async () => {
    const r = await preflightGemini({ ...LLM, model: "nope" }, { apiKey: KEY, fetchImpl: reply(200, { data: [{ id: "models/gemini-2.5-flash" }] }).impl });
    assert.match(r.warnings[0], /nope нет в списке.*GEMINI_MODEL/);
    const down = await preflightGemini(LLM, {
      apiKey: KEY,
      fetchImpl: async () => {
        throw new TypeError("fetch failed");
      },
    });
    assert.match(down.warnings[0], /Gemini недоступен/);
  });
});
