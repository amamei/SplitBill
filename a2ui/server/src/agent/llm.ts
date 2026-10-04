// LLM provider seam: one Anthropic SDK client for both Claude and a local Ollama model
// (Ollama serves the Anthropic-compatible POST /v1/messages), the provider-dependent part
// of the tool-runner request, user-facing error text, and a startup check for Ollama.
import Anthropic from "@anthropic-ai/sdk";
import type { BetaToolRunnerParams } from "@anthropic-ai/sdk/lib/tools/BetaToolRunner";
import { config, type LlmConfig } from "../config.js";
import { createScope } from "../log.js";

const logger = createScope("agent.llm");

export class TruncatedToolInput extends Error {}

export function createLlmClient(llm: LlmConfig): Anthropic {
  if (llm.provider === "anthropic") return new Anthropic();
  // Explicit apiKey skips the `ant` profile lookup; authToken: null keeps a stray
  // ANTHROPIC_AUTH_TOKEN out of requests to the local server. Ollama ignores the key.
  return new Anthropic({ baseURL: llm.baseURL, apiKey: "ollama", authToken: null });
}

let defaultClient: Anthropic | undefined;
export function getLlmClient(): Anthropic {
  if (!defaultClient) {
    defaultClient = createLlmClient(config.llm);
    logger.info("client", { provider: config.llm.provider, ...(config.llm.provider === "ollama" ? { baseURL: config.llm.baseURL } : {}) });
  }
  return defaultClient;
}

export type ProviderParams = Pick<Partial<BetaToolRunnerParams>, "system" | "output_config" | "betas" | "fallbacks">;

/**
 * Provider-dependent part of the toolRunner request. Ollama silently ignores effort,
 * betas, fallbacks and cache_control, so they are left out to keep logs honest.
 */
export function providerParams(llm: LlmConfig, system: string): ProviderParams {
  const params: ProviderParams =
    llm.provider === "anthropic"
      ? {
          system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
          output_config: { effort: llm.effort },
          ...(llm.fallbacks ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
        }
      : { system: [{ type: "text", text: system }] };
  logger.debug("request params", { provider: llm.provider, keys: Object.keys(params) });
  return params;
}

// The SDK has no dedicated class for a missing credential: it arrives as a bare
// AnthropicError (not an APIError), told apart by message / cause.

/** No credential source resolved (no ANTHROPIC_API_KEY / auth token / `ant` profile). */
function isMissingCredentials(err: unknown): boolean {
  const cause = err instanceof Error ? (err.cause as unknown) : undefined;
  return [err, cause].some((e) => e instanceof Error && /resolve authentication method/i.test(e.message));
}

function describeOllamaError(err: unknown, llm: Extract<LlmConfig, { provider: "ollama" }>): string | undefined {
  if (err instanceof Anthropic.APIConnectionError) {
    return `Ollama недоступна по ${llm.baseURL}. Запустите \`ollama serve\` (или приложение Ollama) и повторите.`;
  }
  if (err instanceof Anthropic.NotFoundError && /not found/i.test(err.message)) {
    return `Модель ${llm.model} не найдена в Ollama. Выполните \`ollama pull ${llm.model}\`.`;
  }
  if (err instanceof Anthropic.BadRequestError) {
    if (/does not support tools/i.test(err.message)) return `Модель ${llm.model} не поддерживает инструменты — выберите другую модель.`;
    if (/image|vision/i.test(err.message)) return `Модель ${llm.model} не поддерживает изображения — выберите модель с vision.`;
  }
  return undefined;
}

/** Chat-facing error text for a failed turn. */
export function describeLlmError(err: unknown, llm: LlmConfig): string {
  if (llm.provider === "ollama") {
    const text = describeOllamaError(err, llm);
    if (text) return text;
  }
  if (err instanceof Anthropic.AuthenticationError) return "Нет доступа к Anthropic API. Выполните `ant auth login` (или задайте ANTHROPIC_API_KEY) и перезапустите сервер.";
  if (err instanceof Anthropic.PermissionDeniedError) return "Нет прав на модель или функцию API (403).";
  if (err instanceof Anthropic.RateLimitError) return "Превышен лимит запросов к API, попробуйте через минуту.";
  if (err instanceof Anthropic.BadRequestError) return `Некорректный запрос к API: ${err.message}`;
  if (err instanceof Anthropic.APIError) return `Ошибка API ${err.status ?? ""}: ${err.message}`;
  if (err instanceof TruncatedToolInput) return "Ответ модели обрезан (max_tokens) посреди вызова инструмента.";
  if (isMissingCredentials(err)) {
    return "Нет учётных данных Anthropic. Выполните `ant auth login` (или задайте ANTHROPIC_API_KEY) и перезапустите сервер.";
  }
  return `Ошибка: ${err instanceof Error ? err.message : String(err)}`;
}

export interface PreflightResult {
  reachable: boolean;
  found: boolean;
  capabilities: string[];
  warnings: string[];
}

type FetchLike = (url: string, init: RequestInit) => Promise<Pick<Response, "ok" | "status" | "json">>;

/** Startup check for Ollama: reachable, model pulled, tools + vision. Logs, never throws. */
export async function preflightOllama(llm: Extract<LlmConfig, { provider: "ollama" }>, fetchImpl: FetchLike = fetch): Promise<PreflightResult> {
  const result: PreflightResult = { reachable: false, found: false, capabilities: [], warnings: [] };
  try {
    const res = await fetchImpl(`${llm.baseURL}/api/show`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: llm.model }),
      signal: AbortSignal.timeout(3000),
    });
    result.reachable = true;
    logger.debug("preflight raw", { status: res.status });
    if (res.status === 404) {
      result.warnings.push(`модель ${llm.model} не скачана: \`ollama pull ${llm.model}\``);
    } else if (!res.ok) {
      result.warnings.push(`Ollama ответила ${res.status} на /api/show для ${llm.model}`);
    } else {
      result.found = true;
      const body = (await res.json()) as { capabilities?: unknown };
      result.capabilities = Array.isArray(body.capabilities) ? body.capabilities.map(String) : [];
      if (!result.capabilities.includes("tools")) result.warnings.push(`модель ${llm.model} без tools — агент работать не сможет`);
      if (!result.capabilities.includes("vision")) result.warnings.push(`модель ${llm.model} без vision — загрузка фото (S9) не будет работать`);
    }
  } catch (err) {
    result.warnings.push(`Ollama недоступна по ${llm.baseURL}: запустите \`ollama serve\` (${err instanceof Error ? err.message : String(err)})`);
  }
  for (const warning of result.warnings) logger.warn("ollama preflight", { warning });
  if (result.found) logger.info("ollama ready", { model: llm.model, capabilities: result.capabilities });
  logger.info("ollama context hint", { hint: "нужен контекст ≥ 65536 (OLLAMA_CONTEXT_LENGTH), см. README «Локальная модель через Ollama»" });
  return result;
}
