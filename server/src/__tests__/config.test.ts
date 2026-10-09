import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_DAHL_BASE_URL, DEFAULT_DAHL_MODEL, DEFAULT_OLLAMA_BASE_URL, dahlApiKey, resolveLlmConfig } from "../config.js";

describe("resolveLlmConfig", () => {
  it("defaults to Dahl with MiniMax-M2.7", () => {
    assert.deepEqual(resolveLlmConfig({}), { provider: "dahl", model: "MiniMaxAI/MiniMax-M2.7", baseURL: "https://inference.dahl.global/v1" });
    assert.equal(DEFAULT_DAHL_MODEL, "MiniMaxAI/MiniMax-M2.7");
    assert.equal(DEFAULT_DAHL_BASE_URL, "https://inference.dahl.global/v1");
  });

  it("overrides the Dahl model and base URL, trimming a trailing slash", () => {
    const llm = resolveLlmConfig({ DAHL_MODEL: " zai-org/GLM-5.3-Flash ", DAHL_BASE_URL: "https://h/v1/" });
    assert.deepEqual(llm, { provider: "dahl", model: "zai-org/GLM-5.3-Flash", baseURL: "https://h/v1" });
  });

  it("matches the provider case-insensitively", () => {
    assert.equal(resolveLlmConfig({ LLM_PROVIDER: " Dahl " }).provider, "dahl");
    assert.equal(resolveLlmConfig({ LLM_PROVIDER: "ANTHROPIC" }).provider, "anthropic");
  });

  it("keeps the secret out of the config object", () => {
    const llm = resolveLlmConfig({ DAHL_API_KEY: "sk-secret" });
    assert.doesNotMatch(JSON.stringify(llm), /sk-secret/);
  });

  it("selects Anthropic with the shared model on LLM_PROVIDER=anthropic", () => {
    assert.deepEqual(resolveLlmConfig({ LLM_PROVIDER: "anthropic" }), { provider: "anthropic", model: "claude-opus-5-5", effort: "medium", fallbacks: true });
  });

  it("turns fallbacks off with ANTHROPIC_FALLBACKS=off", () => {
    const llm = resolveLlmConfig({ LLM_PROVIDER: "anthropic", ANTHROPIC_FALLBACKS: "off", ANTHROPIC_MODEL: "claude-sonnet-5-5" });
    assert.equal(llm.provider, "anthropic");
    assert.equal(llm.model, "claude-sonnet-5-5");
    assert.equal(llm.provider === "anthropic" && llm.fallbacks, false);
  });

  it("selects Ollama with the default base URL", () => {
    assert.deepEqual(resolveLlmConfig({ LLM_PROVIDER: "ollama", OLLAMA_MODEL: "m" }), {
      provider: "ollama",
      model: "m",
      baseURL: DEFAULT_OLLAMA_BASE_URL,
    });
  });

  it("matches the provider case-insensitively and trims a trailing slash", () => {
    const llm = resolveLlmConfig({ LLM_PROVIDER: " Ollama ", OLLAMA_MODEL: "m", OLLAMA_BASE_URL: "http://h:1/" });
    assert.equal(llm.provider === "ollama" && llm.baseURL, "http://h:1");
  });

  it("requires OLLAMA_MODEL for Ollama", () => {
    assert.throws(() => resolveLlmConfig({ LLM_PROVIDER: "ollama" }), /OLLAMA_MODEL/);
  });

  it("rejects an unknown provider and lists the valid ones", () => {
    assert.throws(() => resolveLlmConfig({ LLM_PROVIDER: "gpt" }), /LLM_PROVIDER.*"dahl", "anthropic" or "ollama".*"gpt"/);
  });
});

describe("dahlApiKey", () => {
  it("treats a missing or blank key as absent", () => {
    assert.equal(dahlApiKey({}), undefined);
    assert.equal(dahlApiKey({ DAHL_API_KEY: "  " }), undefined);
  });

  it("trims the key", () => {
    assert.equal(dahlApiKey({ DAHL_API_KEY: " k " }), "k");
  });
});
