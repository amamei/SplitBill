// Runtime configuration. Loads the project-root .env (if present) once, before anything reads env.
// The agent runs on the Dahl inference API (default; OpenAI-compatible, key in DAHL_API_KEY), on
// Claude (LLM_PROVIDER=anthropic; credentials from env or the `ant` CLI profile), on a local
// Ollama model through its Anthropic-compatible API (LLM_PROVIDER=ollama), on Google Gemini
// through its OpenAI-compatible API (LLM_PROVIDER=gemini, key in GEMINI_API_KEY) or on any
// OpenRouter model through its OpenAI-compatible API (LLM_PROVIDER=openrouter, key in OPENROUTER_API_KEY).
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createScope } from "./log.js";

const logger = createScope("config");
const here = path.dirname(fileURLToPath(import.meta.url));
// src/config.ts (tsx) and dist/config.js (build) both sit two levels below the project root.
const envPath = path.resolve(here, "../../.env");

let envLoaded = false;
try {
  process.loadEnvFile(envPath);
  envLoaded = true;
} catch {
  // No .env is fine: defaults + the process env (or the `ant` CLI profile / a local Ollama) cover everything.
}

export type CredentialSource =
  | "env:DAHL_API_KEY"
  | "dahl:missing-key"
  | "env:GEMINI_API_KEY"
  | "env:GOOGLE_API_KEY"
  | "gemini:missing-key"
  | "env:OPENROUTER_API_KEY"
  | "openrouter:missing-key"
  | "env:ANTHROPIC_API_KEY"
  | "env:ANTHROPIC_AUTH_TOKEN"
  | "ant-profile"
  | "ollama:none";
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

/** API keys are deliberately not part of LlmConfig: config objects get logged. See dahlApiKey() / geminiApiKey() / openRouterApiKey(). */
export type LlmConfig =
  | { provider: "dahl"; model: string; baseURL: string }
  | { provider: "gemini"; model: string; baseURL: string }
  | { provider: "openrouter"; model: string; baseURL: string }
  | { provider: "anthropic"; model: string; effort: Effort; fallbacks: boolean }
  | { provider: "ollama"; model: string; baseURL: string };

export const DEFAULT_DAHL_BASE_URL = "https://inference.dahl.global/v1";
export const DEFAULT_DAHL_MODEL = "MiniMaxAI/MiniMax-M2.7";
export const DEFAULT_OLLAMA_BASE_URL = "http://localhost:11434";
export const DEFAULT_GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai";
export const DEFAULT_GEMINI_MODEL = "gemini-2.5-flash";
export const DEFAULT_OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
/** The shared hackathon model (TZ §3) through OpenRouter; OPENROUTER_MODEL picks any other. */
export const DEFAULT_OPENROUTER_MODEL = "anthropic/claude-opus-5.5";

/** The Dahl API key, trimmed; blank counts as missing. A missing key is not fatal (see agent/llm.ts). */
export function dahlApiKey(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.DAHL_API_KEY?.trim() || undefined;
}

/** The Gemini API key (GEMINI_API_KEY, else GOOGLE_API_KEY), trimmed; blank counts as missing. */
export function geminiApiKey(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.GEMINI_API_KEY?.trim() || env.GOOGLE_API_KEY?.trim() || undefined;
}

/** The OpenRouter API key, trimmed; blank counts as missing. */
export function openRouterApiKey(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.OPENROUTER_API_KEY?.trim() || undefined;
}

/** Pure: env → provider settings. Throws on an unknown provider or a missing OLLAMA_MODEL. */
export function resolveLlmConfig(env: NodeJS.ProcessEnv): LlmConfig {
  const raw = env.LLM_PROVIDER?.trim().toLowerCase() || "dahl";
  if (raw === "dahl") {
    const model = env.DAHL_MODEL?.trim() || DEFAULT_DAHL_MODEL;
    const baseURL = (env.DAHL_BASE_URL?.trim() || DEFAULT_DAHL_BASE_URL).replace(/\/+$/, "");
    return { provider: "dahl", model, baseURL };
  }
  if (raw === "anthropic") {
    return {
      provider: "anthropic",
      model: env.ANTHROPIC_MODEL || "claude-opus-5-5",
      effort: (env.ANTHROPIC_EFFORT || "medium") as Effort,
      fallbacks: (env.ANTHROPIC_FALLBACKS ?? "default") !== "off",
    };
  }
  if (raw === "ollama") {
    const model = env.OLLAMA_MODEL?.trim();
    if (!model) {
      throw new Error("LLM_PROVIDER=ollama needs OLLAMA_MODEL (see `ollama list`), e.g. OLLAMA_MODEL=qwen3.6:35b-a3b-q4_K_M");
    }
    const baseURL = (env.OLLAMA_BASE_URL?.trim() || DEFAULT_OLLAMA_BASE_URL).replace(/\/+$/, "");
    return { provider: "ollama", model, baseURL };
  }
  if (raw === "gemini") {
    const model = env.GEMINI_MODEL?.trim() || DEFAULT_GEMINI_MODEL;
    const baseURL = (env.GEMINI_BASE_URL?.trim() || DEFAULT_GEMINI_BASE_URL).replace(/\/+$/, "");
    return { provider: "gemini", model, baseURL };
  }
  if (raw === "openrouter") {
    const model = env.OPENROUTER_MODEL?.trim() || DEFAULT_OPENROUTER_MODEL;
    const baseURL = (env.OPENROUTER_BASE_URL?.trim() || DEFAULT_OPENROUTER_BASE_URL).replace(/\/+$/, "");
    return { provider: "openrouter", model, baseURL };
  }
  throw new Error(`LLM_PROVIDER must be "dahl", "anthropic", "ollama", "gemini" or "openrouter", got "${env.LLM_PROVIDER}"`);
}

const llm = resolveLlmConfig(process.env);
logger.debug("llm provider", { provider: llm.provider, model: llm.model, source: process.env.LLM_PROVIDER ? "LLM_PROVIDER" : "default" });

export const config = {
  llm,
  /** Alias of llm.model (telemetry, /api/health, scripts). */
  model: llm.model,
  /** Anthropic only: output_config.effort. */
  effort: (process.env.ANTHROPIC_EFFORT || "medium") as Effort,
  port: Number(process.env.PORT || 8787),
  stream: (process.env.A2UI_STREAM ?? "1") !== "0",
  /** Anthropic only: server-side refusal fallback (`fallbacks: "default"`); ANTHROPIC_FALLBACKS=off keeps every turn on one model. */
  fallbacks: (process.env.ANTHROPIC_FALLBACKS ?? "default") !== "off",
  logLevel: process.env.LOG_LEVEL || "info",
  /** Enables /api/debug/seed (hand-written reference UI, for testing without the model). */
  debug: process.env.A2UI_DEBUG === "1",
  envFile: envLoaded ? envPath : null,
};

/** Label only — never the secret itself. */
export function credentialSource(): CredentialSource {
  if (config.llm.provider === "dahl") return dahlApiKey() ? "env:DAHL_API_KEY" : "dahl:missing-key";
  if (config.llm.provider === "gemini") {
    if (process.env.GEMINI_API_KEY?.trim()) return "env:GEMINI_API_KEY";
    return process.env.GOOGLE_API_KEY?.trim() ? "env:GOOGLE_API_KEY" : "gemini:missing-key";
  }
  if (config.llm.provider === "openrouter") return openRouterApiKey() ? "env:OPENROUTER_API_KEY" : "openrouter:missing-key";
  if (config.llm.provider === "ollama") return "ollama:none";
  if (process.env.ANTHROPIC_API_KEY) return "env:ANTHROPIC_API_KEY";
  if (process.env.ANTHROPIC_AUTH_TOKEN) return "env:ANTHROPIC_AUTH_TOKEN";
  return "ant-profile";
}

export function logConfig(): void {
  const { llm: settings, ...rest } = config;
  logger.info("resolved", {
    ...rest,
    provider: settings.provider,
    ...(settings.provider !== "anthropic" ? { baseURL: settings.baseURL, effort: undefined, fallbacks: undefined } : {}),
    credentials: credentialSource(),
  });
}
