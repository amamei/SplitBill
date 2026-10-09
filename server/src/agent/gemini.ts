// Google Gemini through its OpenAI-compatible endpoint
// (https://generativelanguage.googleapis.com/v1beta/openai/chat/completions, Bearer GEMINI_API_KEY)
// and the shared OpenAI-compatible tool runner in ./openai-compat.ts. Gemini models read images,
// so receipt photos (S9) are sent as `image_url` data URLs.
import type Anthropic from "@anthropic-ai/sdk";
import { geminiApiKey, type LlmConfig } from "../config.js";
import { createScope } from "../log.js";
import { ChatApiError, ChatConnectionError, ChatMissingKeyError, createOpenAiCompatClient, type OpenAiCompatOptions } from "./openai-compat.js";

export type GeminiConfig = Extract<LlmConfig, { provider: "gemini" }>;
export type GeminiClientOptions = OpenAiCompatOptions;

export class GeminiApiError extends ChatApiError {}
export class GeminiConnectionError extends ChatConnectionError {}
export class GeminiMissingKeyError extends ChatMissingKeyError {
  constructor() {
    super("GEMINI_API_KEY is not set");
  }
}

const logger = createScope("agent.gemini");

export function createGeminiClient(llm: GeminiConfig, opts: GeminiClientOptions = {}): Pick<Anthropic, "beta"> {
  logger.info("client", { model: llm.model, baseURL: llm.baseURL, keyPresent: Boolean("apiKey" in opts ? opts.apiKey?.trim() : geminiApiKey()), vision: true });
  return createOpenAiCompatClient(
    llm,
    { label: "gemini", apiKey: geminiApiKey, allowImages: true, errors: { api: GeminiApiError, connection: GeminiConnectionError, missingKey: GeminiMissingKeyError } },
    opts,
  );
}
