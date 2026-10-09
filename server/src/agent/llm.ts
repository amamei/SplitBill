// LLM provider seam: the client behind the agent's tool-runner surface (the Dahl inference API
// through ./dahl.ts, or the Anthropic SDK for Claude and for a local Ollama model, which serves the
// Anthropic-compatible POST /v1/messages), the provider-dependent part of the tool-runner
// request, user-facing error text, and startup checks for Dahl and Ollama.
import Anthropic from "@anthropic-ai/sdk";
import type { BetaToolRunnerParams } from "@anthropic-ai/sdk/lib/tools/BetaToolRunner";
import { config, dahlApiKey, type LlmConfig } from "../config.js";
import { createScope } from "../log.js";
import { createDahlClient, DahlApiError, DahlConnectionError, DahlMissingKeyError, UnsupportedContentError, type DahlConfig } from "./dahl.js";

const logger = createScope("agent.llm");

export class TruncatedToolInput extends Error {}

/** The Anthropic SDK client: Claude, or a local Ollama server (Dahl has its own client, see createAgentClient). */
export function createLlmClient(llm: Exclude<LlmConfig, { provider: "dahl" }>): Anthropic {
  if (llm.provider === "anthropic") return new Anthropic();
  // Explicit apiKey skips the `ant` profile lookup; authToken: null keeps a stray
  // ANTHROPIC_AUTH_TOKEN out of requests to the local server. Ollama ignores the key.
  return new Anthropic({ baseURL: llm.baseURL, apiKey: "ollama", authToken: null });
}

/** What runner.ts needs from any provider: `client.beta.messages.toolRunner(params)`. */
export function createAgentClient(llm: LlmConfig): Pick<Anthropic, "beta"> {
  return llm.provider === "dahl" ? createDahlClient(llm) : createLlmClient(llm);
}

let defaultClient: Pick<Anthropic, "beta"> | undefined;
export function getLlmClient(): Pick<Anthropic, "beta"> {
  if (!defaultClient) {
    defaultClient = createAgentClient(config.llm);
    logger.info("client", { provider: config.llm.provider, ...(config.llm.provider !== "anthropic" ? { baseURL: config.llm.baseURL } : {}) });
  }
  return defaultClient;
}

/** Whether the provider's model can read images (receipt photos, S9). No Dahl model can. */
export function supportsVision(llm: LlmConfig): boolean {
  return llm.provider !== "dahl";
}

export type ProviderParams = Pick<Partial<BetaToolRunnerParams>, "system" | "output_config" | "betas" | "fallbacks">;

/**
 * Provider-dependent part of the toolRunner request. Ollama silently ignores effort,
 * betas, fallbacks and cache_control, and Dahl has none of them, so they are left out to keep
 * logs honest (the Dahl adapter flattens the system block into one system message).
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
  if (err instanceof Anthropic.NotFoundError) {
    if (/model\b.*not found/i.test(err.message)) return `Модель ${llm.model} не найдена в Ollama. Выполните \`ollama pull ${llm.model}\`.`;
    // A bare "404 page not found": the server has no /v1/messages (Ollama before the Anthropic-compatible API).
    return `Ollama по ${llm.baseURL} не отдаёт /v1/messages (404). Обновите Ollama до версии с Anthropic-совместимым API или проверьте OLLAMA_BASE_URL.`;
  }
  if (err instanceof Anthropic.BadRequestError) {
    if (/does not support tools/i.test(err.message)) return `Модель ${llm.model} не поддерживает инструменты — выберите другую модель.`;
    if (/image|vision/i.test(err.message)) return `Модель ${llm.model} не поддерживает изображения — выберите модель с vision.`;
  }
  return undefined;
}

function describeDahlError(err: unknown, llm: DahlConfig): string | undefined {
  if (err instanceof DahlMissingKeyError) return "Не задан DAHL_API_KEY. Добавьте ключ в .env и перезапустите сервер.";
  if (err instanceof UnsupportedContentError) return `Модель ${llm.model} в Dahl не читает изображения — опишите чек текстом.`;
  if (err instanceof DahlConnectionError) return `Нет соединения с Dahl (${llm.baseURL}): ${err.message}. Проверьте сеть и повторите.`;
  if (err instanceof DahlApiError) {
    if (err.status === 401) return "Dahl не принял ключ (401). Проверьте DAHL_API_KEY и перезапустите сервер.";
    if (err.status === 402) return "У ключа Dahl закончились токены (402). Пополните баланс или выделите токены из пула.";
    if (err.status === 429) return "Слишком много запросов к Dahl, попробуйте через минуту.";
    if (err.status === 400 && /not currently offered/i.test(err.message)) {
      return `Модель ${llm.model} сейчас не доступна в Dahl («${err.message}»). Задайте в DAHL_MODEL одну из доступных.`;
    }
    if (err.status === 400) return `Некорректный запрос к Dahl: ${err.message}`;
    if (err.status >= 500) return `Dahl временно недоступен (${err.status}), повторите через пару секунд.`;
    return `Ошибка Dahl ${err.status}: ${err.message}`;
  }
  return undefined;
}

/** Chat-facing error text for a failed turn. */
export function describeLlmError(err: unknown, llm: LlmConfig): string {
  if (llm.provider === "dahl") {
    const text = describeDahlError(err, llm);
    if (text) return text;
  } else if (llm.provider === "ollama") {
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

export interface DahlPreflightResult {
  reachable: boolean;
  modelListed: boolean;
  keyPresent: boolean;
  /** null: not checked (no key, or Dahl unreachable) or inconclusive. */
  keyAccepted: boolean | null;
  models: string[];
  warnings: string[];
}

/**
 * Startup check for Dahl: key present, model listed in the public /models, key accepted by the
 * balance endpoint at the service root. Logs, never throws; the body of the balance reply is not read.
 */
export async function preflightDahl(llm: DahlConfig, opts: { apiKey?: string; fetchImpl?: FetchLike } = {}): Promise<DahlPreflightResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const key = "apiKey" in opts ? opts.apiKey?.trim() || undefined : dahlApiKey();
  const result: DahlPreflightResult = { reachable: false, modelListed: false, keyPresent: Boolean(key), keyAccepted: null, models: [], warnings: [] };

  if (!key) result.warnings.push("DAHL_API_KEY не задан — чат будет отвечать ошибкой, пока ключ не добавлен в .env");

  try {
    const res = await fetchImpl(`${llm.baseURL}/models`, { method: "GET", signal: AbortSignal.timeout(3000) });
    result.reachable = true;
    logger.debug("preflight raw", { path: "/models", status: res.status });
    if (!res.ok) {
      result.warnings.push(`Dahl ответил ${res.status} на /models`);
    } else {
      const body = (await res.json()) as { data?: Array<{ id?: unknown }> };
      result.models = (Array.isArray(body.data) ? body.data : []).map((m) => String(m.id)).filter(Boolean);
      result.modelListed = result.models.includes(llm.model);
      if (!result.modelListed) result.warnings.push(`модель ${llm.model} нет в /v1/models; сейчас доступны: ${result.models.join(", ") || "—"} (задайте DAHL_MODEL)`);
    }
  } catch (err) {
    result.warnings.push(`Dahl недоступен по ${llm.baseURL}: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (key && result.reachable) {
    try {
      const res = await fetchImpl(new URL("/tokens/current", llm.baseURL).toString(), {
        method: "GET",
        headers: { authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(3000),
      });
      logger.debug("preflight raw", { path: "/tokens/current", status: res.status });
      if (res.status === 401) {
        result.keyAccepted = false;
        result.warnings.push("Dahl не принял DAHL_API_KEY (401)");
      } else if (res.ok) {
        result.keyAccepted = true;
      }
    } catch (err) {
      logger.debug("preflight key check failed", { err: err instanceof Error ? err.message : String(err) });
    }
  }

  for (const warning of result.warnings) logger.warn("dahl preflight", { warning });
  if (result.reachable && result.modelListed && result.keyAccepted !== false && result.keyPresent) {
    logger.info("dahl ready", { model: llm.model, models: result.models, keyAccepted: result.keyAccepted });
  }
  logger.info("dahl vision", { hint: "Dahl не читает изображения: загрузка фото чека (S9) отключена" });
  return result;
}
