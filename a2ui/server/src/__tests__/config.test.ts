import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_OLLAMA_BASE_URL, resolveLlmConfig } from "../config.js";

describe("resolveLlmConfig", () => {
  it("defaults to Anthropic with the shared model", () => {
    assert.deepEqual(resolveLlmConfig({}), { provider: "anthropic", model: "claude-opus-5-5", effort: "medium", fallbacks: true });
  });

  it("turns fallbacks off with ANTHROPIC_FALLBACKS=off", () => {
    const llm = resolveLlmConfig({ ANTHROPIC_FALLBACKS: "off", ANTHROPIC_MODEL: "claude-sonnet-5-5" });
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

  it("rejects an unknown provider", () => {
    assert.throws(() => resolveLlmConfig({ LLM_PROVIDER: "gpt" }), /LLM_PROVIDER/);
  });
});
