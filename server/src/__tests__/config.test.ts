import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_DAHL_BASE_URL,
  DEFAULT_DAHL_MODEL,
  DEFAULT_GEMINI_BASE_URL,
  DEFAULT_GEMINI_MODEL,
  DEFAULT_OLLAMA_BASE_URL,
  DEFAULT_OPENROUTER_BASE_URL,
  DEFAULT_OPENROUTER_MODEL,
  dahlApiKey,
  geminiApiKey,
  openRouterApiKey,
  resolveLlmConfig,
} from "../config.js";

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

  it("selects Gemini with the default model and its OpenAI-compatible base URL", () => {
    assert.deepEqual(resolveLlmConfig({ LLM_PROVIDER: "gemini" }), { provider: "gemini", model: DEFAULT_GEMINI_MODEL, baseURL: DEFAULT_GEMINI_BASE_URL });
    assert.equal(DEFAULT_GEMINI_BASE_URL, "https://generativelanguage.googleapis.com/v1beta/openai");
  });

  it("overrides the Gemini model and base URL, trimming a trailing slash, and keeps the key out", () => {
    const llm = resolveLlmConfig({ LLM_PROVIDER: " Gemini ", GEMINI_MODEL: " gemini-2.5-pro ", GEMINI_BASE_URL: "https://g/v1/", GEMINI_API_KEY: "g-secret" });
    assert.deepEqual(llm, { provider: "gemini", model: "gemini-2.5-pro", baseURL: "https://g/v1" });
    assert.doesNotMatch(JSON.stringify(llm), /g-secret/);
  });

  it("selects OpenRouter with the shared model and its OpenAI-compatible base URL", () => {
    assert.deepEqual(resolveLlmConfig({ LLM_PROVIDER: "openrouter" }), { provider: "openrouter", model: DEFAULT_OPENROUTER_MODEL, baseURL: DEFAULT_OPENROUTER_BASE_URL });
    assert.equal(DEFAULT_OPENROUTER_BASE_URL, "https://openrouter.ai/api/v1");
    assert.equal(DEFAULT_OPENROUTER_MODEL, "anthropic/claude-opus-5.5");
  });

  it("overrides the OpenRouter model and base URL, trimming a trailing slash, and keeps the key out", () => {
    const llm = resolveLlmConfig({ LLM_PROVIDER: " OpenRouter ", OPENROUTER_MODEL: " google/gemini-2.5-flash ", OPENROUTER_BASE_URL: "https://or/api/v1/", OPENROUTER_API_KEY: "sk-or-secret" });
    assert.deepEqual(llm, { provider: "openrouter", model: "google/gemini-2.5-flash", baseURL: "https://or/api/v1" });
    assert.doesNotMatch(JSON.stringify(llm), /sk-or-secret/);
  });

  it("rejects an unknown provider and lists the valid ones", () => {
    assert.throws(() => resolveLlmConfig({ LLM_PROVIDER: "gpt" }), /LLM_PROVIDER.*"dahl", "anthropic", "ollama", "gemini" or "openrouter".*"gpt"/);
  });
});

describe("openRouterApiKey", () => {
  it("trims the key and treats a missing or blank key as absent", () => {
    assert.equal(openRouterApiKey({}), undefined);
    assert.equal(openRouterApiKey({ OPENROUTER_API_KEY: "  " }), undefined);
    assert.equal(openRouterApiKey({ OPENROUTER_API_KEY: " sk-or-1 " }), "sk-or-1");
  });
});

describe("geminiApiKey", () => {
  it("reads GEMINI_API_KEY, falls back to GOOGLE_API_KEY, and treats blank as absent", () => {
    assert.equal(geminiApiKey({}), undefined);
    assert.equal(geminiApiKey({ GEMINI_API_KEY: "  " }), undefined);
    assert.equal(geminiApiKey({ GEMINI_API_KEY: " g " }), "g");
    assert.equal(geminiApiKey({ GOOGLE_API_KEY: " o " }), "o");
    assert.equal(geminiApiKey({ GEMINI_API_KEY: "g", GOOGLE_API_KEY: "o" }), "g");
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
