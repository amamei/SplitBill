import { describe, it } from "node:test";
import assert from "node:assert/strict";
import Anthropic from "@anthropic-ai/sdk";
import type { LlmConfig } from "../../config.js";
import { describeLlmError, preflightOllama, providerParams } from "../llm.js";

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

  it("names a model without tool support", () => {
    assert.match(describeLlmError(noTools, ollama), /не поддерживает инструменты/);
  });

  it("keeps the Anthropic texts unchanged", () => {
    const auth = Anthropic.APIError.generate(401, { type: "error", error: { type: "authentication_error", message: "bad key" } }, undefined, new Headers());
    assert.equal(describeLlmError(auth, anthropic(true)), "Нет доступа к Anthropic API. Выполните `ant auth login` (или задайте ANTHROPIC_API_KEY) и перезапустите сервер.");
    assert.doesNotMatch(describeLlmError(notFound, anthropic(true)), /ollama/);
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
