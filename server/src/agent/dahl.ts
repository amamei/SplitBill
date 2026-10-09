// Dahl inference API (OpenAI-compatible chat completions, no vision) through the shared
// OpenAI-compatible tool runner in ./openai-compat.ts.
import type Anthropic from "@anthropic-ai/sdk";
import { dahlApiKey, type LlmConfig } from "../config.js";
import { ChatApiError, ChatConnectionError, ChatMissingKeyError, createOpenAiCompatClient, UnsupportedContentError, type OpenAiCompatOptions } from "./openai-compat.js";

export { UnsupportedContentError };

export type DahlConfig = Extract<LlmConfig, { provider: "dahl" }>;
export type DahlClientOptions = OpenAiCompatOptions;

export class DahlApiError extends ChatApiError {}
export class DahlConnectionError extends ChatConnectionError {}
export class DahlMissingKeyError extends ChatMissingKeyError {
  constructor() {
    super("DAHL_API_KEY is not set");
  }
}

export function createDahlClient(llm: DahlConfig, opts: DahlClientOptions = {}): Pick<Anthropic, "beta"> {
  return createOpenAiCompatClient(
    llm,
    { label: "dahl", apiKey: dahlApiKey, allowImages: false, errors: { api: DahlApiError, connection: DahlConnectionError, missingKey: DahlMissingKeyError } },
    opts,
  );
}
