import { describe, it } from "node:test";
import assert from "node:assert/strict";
import Anthropic from "@anthropic-ai/sdk";
import type { LlmConfig } from "../../config.js";
import { DahlApiError, DahlConnectionError, DahlMissingKeyError, UnsupportedContentError } from "../dahl.js";
import { describeLlmError, preflightDahl, preflightOllama, providerParams, supportsVision } from "../llm.js";

const dahl = { provider: "dahl", model: "MiniMaxAI/MiniMax-M2.7", baseURL: "https://inference.dahl.global/v1" } as const satisfies LlmConfig;
const ollama = { provider: "ollama", model: "x", baseURL: "http://h:11434" } as const satisfies LlmConfig;
const anthropic = (fallbacks: boolean) => ({ provider: "anthropic", model: "claude-opus-5-5", effort: "medium", fallbacks }) as const satisfies LlmConfig;

describe("providerParams", () => {
  it("keeps the Anthropic request shape (cache, effort, fallbacks)", () => {
    assert.deepEqual(providerParams(anthropic(true), "SYS"), {
      system: [{ type: "text", text: "SYS", cache_control: { type: "ephemeral" } }],
      output_config: { effort: "medium" },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    });
    const off = providerParams(anthropic(false), "SYS");
    assert.equal("betas" in off, false);
    assert.equal("fallbacks" in off, false);
  });

  it("sends Ollama only a plain system block", () => {
    assert.deepEqual(providerParams(ollama, "SYS"), { system: [{ type: "text", text: "SYS" }] });
  });

  it("sends Dahl only a plain system block: no cache_control, effort, betas or fallbacks", () => {
    assert.deepEqual(providerParams(dahl, "SYS"), { system: [{ type: "text", text: "SYS" }] });
  });
});

describe("supportsVision", () => {
  it("is false for Dahl (no model offers vision) and true for the others", () => {
    assert.equal(supportsVision(dahl), false);
    assert.equal(supportsVision(ollama), true);
    assert.equal(supportsVision(anthropic(true)), true);
  });
});

describe("describeLlmError", () => {
  const notFound = Anthropic.APIError.generate(404, { type: "error", error: { type: "not_found_error", message: "model 'x' not found" } }, undefined, new Headers());
  const noTools = Anthropic.APIError.generate(400, { type: "error", error: { type: "invalid_request_error", message: "x does not support tools" } }, undefined, new Headers());

  it("explains a stopped Ollama server", () => {
    const text = describeLlmError(new Anthropic.APIConnectionError({ message: "Connection error." }), ollama);
    assert.match(text, /http:\/\/h:11434/);
    assert.match(text, /ollama serve/);
  });

  it("suggests ollama pull for a missing model", () => {
    assert.match(describeLlmError(notFound, ollama), /ollama pull x/);
  });

  it("tells an outdated Ollama (no /v1/messages) apart from a missing model", () => {
    const noRoute = Anthropic.APIError.generate(404, undefined, "404 page not found", new Headers());
    const text = describeLlmError(noRoute, ollama);
    assert.doesNotMatch(text, /ollama pull/);
    assert.match(text, /\/v1\/messages/);
  });

  it("names a model without tool support", () => {
    assert.match(describeLlmError(noTools, ollama), /не поддерживает инструменты/);
  });

  it("keeps the Anthropic texts unchanged", () => {
    const auth = Anthropic.APIError.generate(401, { type: "error", error: { type: "authentication_error", message: "bad key" } }, undefined, new Headers());
    assert.equal(describeLlmError(auth, anthropic(true)), "Нет доступа к Anthropic API. Выполните `ant auth login` (или задайте ANTHROPIC_API_KEY) и перезапустите сервер.");
    assert.doesNotMatch(describeLlmError(notFound, anthropic(true)), /ollama/);
  });
});

describe("describeLlmError for Dahl", () => {
  it("asks for the key when it is missing", () => {
    assert.match(describeLlmError(new DahlMissingKeyError(), dahl), /Не задан DAHL_API_KEY/);
  });

  it("explains 401, 402 and 429", () => {
    assert.match(describeLlmError(new DahlApiError(401, "invalid API token"), dahl), /не принял ключ \(401\).*DAHL_API_KEY/);
    assert.match(describeLlmError(new DahlApiError(402, "x"), dahl), /закончились токены \(402\)/);
    assert.match(describeLlmError(new DahlApiError(429, "x"), dahl), /Слишком много запросов к Dahl/);
  });

  it("names the model and keeps every live id of a model-not-offered 400", () => {
    const message = "This model is not currently offered. Available: MiniMaxAI/MiniMax-M2.7, deepseek-ai/DeepSeek-V4-Flash-0731, zai-org/GLM-5.3-Flash";
    const text = describeLlmError(new DahlApiError(400, message), { ...dahl, model: "nope/none" });
    assert.match(text, /Модель nope\/none сейчас не доступна в Dahl/);
    for (const id of ["MiniMaxAI/MiniMax-M2.7", "deepseek-ai/DeepSeek-V4-Flash-0731", "zai-org/GLM-5.3-Flash"]) assert.ok(text.includes(id), id);
    assert.match(text, /DAHL_MODEL/);
  });

  it("covers other 400s, 5xx, other statuses and connection errors", () => {
    assert.equal(describeLlmError(new DahlApiError(400, "bad field"), dahl), "Некорректный запрос к Dahl: bad field");
    assert.match(describeLlmError(new DahlApiError(503, "overloaded"), dahl), /Dahl временно недоступен \(503\)/);
    assert.equal(describeLlmError(new DahlApiError(418, "teapot"), dahl), "Ошибка Dahl 418: teapot");
    const text = describeLlmError(new DahlConnectionError("fetch failed: ECONNREFUSED"), dahl);
    assert.match(text, /https:\/\/inference\.dahl\.global\/v1/);
    assert.match(text, /ECONNREFUSED/);
  });

  it("says a Dahl model cannot read images", () => {
    assert.match(describeLlmError(new UnsupportedContentError("image"), dahl), /не читает изображения/);
  });

  it("falls back to the generic text for anything else, and never leaks Dahl texts to other providers", () => {
    assert.equal(describeLlmError(new Error("boom"), dahl), "Ошибка: boom");
    assert.doesNotMatch(describeLlmError(new DahlApiError(401, "x"), anthropic(true)), /DAHL_API_KEY/);
  });
});

describe("preflightDahl", () => {
  type Reply = { status: number; body?: unknown };
  /** Routes by URL: `models` for /v1/models, `tokens` for /tokens/current. */
  const router = (routes: { models?: Reply | Error; tokens?: Reply | Error }) => {
    const calls: Array<{ url: string; auth?: string }> = [];
    const impl = async (url: string, init: RequestInit) => {
      const headers = init.headers as Record<string, string> | undefined;
      calls.push({ url, auth: headers?.authorization });
      const route = url.endsWith("/models") ? routes.models : routes.tokens;
      if (!route) throw new Error(`unexpected ${url}`);
      if (route instanceof Error) throw route;
      return { ok: route.status < 400, status: route.status, json: async () => route.body ?? {} };
    };
    return { impl, calls };
  };
  const listed = { status: 200, body: { data: [{ id: "MiniMaxAI/MiniMax-M2.7" }, { id: "zai-org/GLM-5.3-Flash" }] } };

  it("has no warnings when the key is accepted and the model is listed", async () => {
    const { impl, calls } = router({ models: listed, tokens: { status: 200 } });
    const r = await preflightDahl(dahl, { apiKey: "k-0123456789", fetchImpl: impl });
    assert.deepEqual(r.warnings, []);
    assert.equal(r.reachable && r.modelListed && r.keyPresent && r.keyAccepted, true);
    assert.deepEqual(r.models, ["MiniMaxAI/MiniMax-M2.7", "zai-org/GLM-5.3-Flash"]);
    assert.equal(calls[0].url, "https://inference.dahl.global/v1/models");
    assert.equal(calls[0].auth, undefined, "the public model list is fetched without the key");
    assert.equal(calls[1].url, "https://inference.dahl.global/tokens/current");
    assert.equal(calls[1].auth, "Bearer k-0123456789");
  });

  it("warns about a missing key and skips the balance request", async () => {
    const { impl, calls } = router({ models: listed });
    const r = await preflightDahl(dahl, { apiKey: undefined, fetchImpl: impl });
    assert.equal(r.keyPresent, false);
    assert.equal(r.keyAccepted, null);
    assert.match(r.warnings[0], /DAHL_API_KEY не задан/);
    assert.equal(calls.length, 1);
  });

  it("lists the live models when the configured one is missing", async () => {
    const { impl } = router({ models: listed, tokens: { status: 200 } });
    const r = await preflightDahl({ ...dahl, model: "nope/none" }, { apiKey: "k-0123456789", fetchImpl: impl });
    assert.equal(r.modelListed, false);
    assert.match(r.warnings[0], /nope\/none нет в \/v1\/models.*MiniMaxAI\/MiniMax-M2\.7, zai-org\/GLM-5\.3-Flash.*DAHL_MODEL/);
  });

  it("reports an unreachable Dahl without throwing, and does not try the balance request", async () => {
    const { impl, calls } = router({ models: new TypeError("fetch failed") });
    const r = await preflightDahl(dahl, { apiKey: "k-0123456789", fetchImpl: impl });
    assert.equal(r.reachable, false);
    assert.match(r.warnings[0], /Dahl недоступен по https:\/\/inference\.dahl\.global\/v1/);
    assert.equal(calls.length, 1);
  });

  it("flags a rejected key", async () => {
    const { impl } = router({ models: listed, tokens: { status: 401 } });
    const r = await preflightDahl(dahl, { apiKey: "k-0123456789", fetchImpl: impl });
    assert.equal(r.keyAccepted, false);
    assert.ok(r.warnings.some((w) => /не принял DAHL_API_KEY \(401\)/.test(w)));
  });

  it("stays quiet about the key when the balance endpoint answers something unexpected", async () => {
    const { impl } = router({ models: listed, tokens: { status: 404 } });
    const r = await preflightDahl(dahl, { apiKey: "k-0123456789", fetchImpl: impl });
    assert.equal(r.keyAccepted, null);
    assert.deepEqual(r.warnings, []);
  });
});

describe("preflightOllama", () => {
  const reply = (status: number, body: unknown = {}) => async () => ({ ok: status < 400, status, json: async () => body });

  it("warns only about vision for a tools-only model", async () => {
    const r = await preflightOllama(ollama, reply(200, { capabilities: ["completion", "tools"] }));
    assert.equal(r.found, true);
    assert.equal(r.warnings.length, 1);
    assert.match(r.warnings[0], /vision/);
  });

  it("has no warnings for a model with tools and vision", async () => {
    const r = await preflightOllama(ollama, reply(200, { capabilities: ["completion", "vision", "tools"] }));
    assert.deepEqual(r.warnings, []);
  });

  it("suggests a pull when the model is missing", async () => {
    const r = await preflightOllama(ollama, reply(404));
    assert.equal(r.reachable, true);
    assert.equal(r.found, false);
    assert.match(r.warnings[0], /ollama pull x/);
  });

  it("reports an unreachable server without throwing", async () => {
    const r = await preflightOllama(ollama, async () => {
      throw new TypeError("fetch failed");
    });
    assert.equal(r.reachable, false);
    assert.match(r.warnings[0], /ollama serve/);
  });
});
