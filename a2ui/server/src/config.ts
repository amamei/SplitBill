// Runtime configuration. Loads a2ui/.env (if present) once, before anything reads env.
// The agent runs on Claude (default; credentials from env or the `ant` CLI profile) or on a
// local Ollama model through its Anthropic-compatible API (LLM_PROVIDER=ollama).
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createScope } from "./log.js";

const logger = createScope("config");
const here = path.dirname(fileURLToPath(import.meta.url));
// src/config.ts (tsx) and dist/config.js (build) both sit two levels below a2ui/.
const envPath = path.resolve(here, "../../.env");

let envLoaded = false;
try {
  process.loadEnvFile(envPath);
  envLoaded = true;
} catch {
  // No .env is fine: defaults + the `ant` CLI profile (or a local Ollama) cover everything.
}

export type CredentialSource = "env:ANTHROPIC_API_KEY" | "env:ANTHROPIC_AUTH_TOKEN" | "ant-profile" | "ollama:none";
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export type LlmConfig =
  | { provider: "anthropic"; model: string; effort: Effort; fallbacks: boolean }
  | { provider: "ollama"; model: string; baseURL: string };

export const DEFAULT_OLLAMA_BASE_URL = "http://localhost:11434";

/** Pure: env → provider settings. Throws on an unknown provider or a missing OLLAMA_MODEL. */
export function resolveLlmConfig(env: NodeJS.ProcessEnv): LlmConfig {
  const raw = env.LLM_PROVIDER?.trim().toLowerCase() || "anthropic";
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
  throw new Error(`LLM_PROVIDER must be "anthropic" or "ollama", got "${env.LLM_PROVIDER}"`);
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
    ...(settings.provider === "ollama" ? { baseURL: settings.baseURL, effort: undefined, fallbacks: undefined } : {}),
    credentials: credentialSource(),
  });
}
