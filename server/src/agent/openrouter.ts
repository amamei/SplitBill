// OpenRouter (https://openrouter.ai/api/v1/chat/completions, Bearer OPENROUTER_API_KEY): one
// OpenAI-compatible gateway to many vendors' models, through the shared OpenAI-compatible tool
// runner in ./openai-compat.ts. Images (receipt photos, S9) are sent as `image_url` data URLs;
// whether the chosen model reads them is checked by preflightOpenRouter in ./llm.ts. Every request
// carries OpenRouter's optional app-attribution headers.
import type Anthropic from "@anthropic-ai/sdk";
import { openRouterApiKey, type LlmConfig } from "../config.js";
import { createScope } from "../log.js";
import { ChatApiError, ChatConnectionError, ChatMissingKeyError, createOpenAiCompatClient, type OpenAiCompatOptions } from "./openai-compat.js";

export type OpenRouterConfig = Extract<LlmConfig, { provider: "openrouter" }>;
export type OpenRouterClientOptions = OpenAiCompatOptions;

export class OpenRouterApiError extends ChatApiError {}
export class OpenRouterConnectionError extends ChatConnectionError {}
export class OpenRouterMissingKeyError extends ChatMissingKeyError {
  constructor() {
    super("OPENROUTER_API_KEY is not set");
  }
}

/** OpenRouter app attribution (https://openrouter.ai/docs/app-attribution); not secret. */
export const OPENROUTER_ATTRIBUTION: Readonly<Record<string, string>> = {
  "HTTP-Referer": "https://github.com/amamei/SplitBill",
  "X-Title": "SplitBill A2UI",
};

const logger = createScope("agent.openrouter");

export function createOpenRouterClient(llm: OpenRouterConfig, opts: OpenRouterClientOptions = {}): Pick<Anthropic, "beta"> {
  logger.info("client", { model: llm.model, baseURL: llm.baseURL, keyPresent: Boolean("apiKey" in opts ? opts.apiKey?.trim() : openRouterApiKey()), vision: true });
  return createOpenAiCompatClient(
    llm,
    {
      label: "openrouter",
      apiKey: openRouterApiKey,
      allowImages: true,
      headers: { ...OPENROUTER_ATTRIBUTION },
      errors: { api: OpenRouterApiError, connection: OpenRouterConnectionError, missingKey: OpenRouterMissingKeyError },
    },
    opts,
  );
}
