# Implementation Plan: OpenRouter as an LLM provider

Branch: feature/openrouter-api-provider (created from `main` with the uncommitted Gemini / `openai-compat.ts` work in the tree; this plan builds on that provider seam, see `.ai-factory/patches/2026-10-09-13.24.md`)
Created: 2026-10-09

## Original Request
add openrouter api provider

## Settings
- Testing: yes
- Logging: verbose
- Docs: yes  # mandatory docs checkpoint in /aif-implement: README.md, .env.example and docs/DEMO.md. REPORT.md is not touched.

## Design Summary

- **What OpenRouter is** (OpenRouter API docs, plus public endpoints probed on 2026-10-09):
  - Base URL `https://openrouter.ai/api/v1`, `Authorization: Bearer <key>`, conventional variable `OPENROUTER_API_KEY`.
  - OpenAI-compatible `POST /chat/completions` with SSE streaming, `tools`, `max_tokens`, `stream_options`. Model IDs are `<vendor>/<model>` (e.g. `anthropic/claude-opus-5.5`, `google/gemini-2.5-flash`).
  - **Verified live:** `GET /api/v1/models` is public (200, 469 models). Each entry has `id`, `context_length`, `architecture.input_modalities` (e.g. `["text","image","file"]`), `supported_parameters` (contains `"tools"` when tool calling works) and `top_provider.max_completion_tokens`. `anthropic/claude-opus-5.5`: 1M context, 128K max completion, image input, tools. Unauthenticated `GET /api/v1/key` and `POST /api/v1/chat/completions` return `401 {"error":{"message":"No cookie auth credentials found","code":401}}`. `extractErrorMessage()` in `server/src/agent/dahl-wire.ts` already reads `error.message`.
  - Documented, **not verifiable without a key** (none in this environment). These are assumptions B1–B5, checked by Task 8:
    - B1: the final stream chunk carries `usage` when `stream_options.include_usage` is set.
    - B2: mid-stream failures arrive as a chunk with a top-level `error: {code, message}` (and `finish_reason: "error"`). `Assembler.ingest()` in `server/src/agent/openai-compat.ts` already throws the profile's API error on `chunk.error`.
    - B3: keep-alive SSE comments (`: OPENROUTER PROCESSING`). `parseSse()` already skips lines starting with `:` (`dahl-wire.ts:216`).
    - B4: error statuses are 400 bad request, 401 bad key, 402 out of credits, 403 moderation, 404 unknown model / no endpoint, 408 timeout, 429 rate limit, 502 upstream model error and 503 no provider available. 502 and 503 are already retried (`RETRYABLE_STATUSES`).
    - B5: `GET /api/v1/key` with the Bearer key returns 200 `{data:{label, limit, usage, limit_remaining, is_free_tier, …}}` for a valid key and 401 for a bad one.
  - Optional app-attribution headers: `HTTP-Referer` and `X-Title`.

- **Approach: one more thin wrapper over the shared OpenAI-compatible engine.** This follows the rule from patch `2026-10-09-13.24`: parameterize, don't copy.
  - `server/src/agent/openrouter.ts` mirrors `gemini.ts`. It defines `OpenRouterApiError`, `OpenRouterConnectionError` and `OpenRouterMissingKeyError` (all subclassing the `Chat*` bases), sets `allowImages: true`, and uses the label `openrouter` (log scope `agent.openrouter`, message ids `openrouter_…`).
  - The only engine change: `ProviderProfile` gains an optional `headers?: Record<string, string>`. `openResponse()` merges these headers *under* the fixed ones, so a profile can never override `authorization` or `content-type`. OpenRouter passes `HTTP-Referer: https://github.com/amamei/SplitBill` and `X-Title: SplitBill A2UI`.
  - No new wire code. History, tools, the `<think>` filter, reasoning-chunk counting and retries are all reused.

- **Decisions** (taken by default: this plan was made in Handoff mode, with no questions asked):
  - D1, default model `anthropic/claude-opus-5.5`. TZ §3 requires one shared model, and the Anthropic path defaults to `claude-opus-5-5`, so OpenRouter is "the same model through another gateway". It has tools, image input, and 128K max completion (the runner asks for `max_tokens: 32000`). `OPENROUTER_MODEL` overrides it. `.env.example` mentions `google/gemini-2.5-flash` as the cheap alternative.
  - D2, vision: `supportsVision()` returns `true` for openrouter, as it already does for Ollama, so `/api/health` and the S9 upload stay synchronous. The preflight warns when the chosen model's `input_modalities` lack `"image"` or its `supported_parameters` lack `"tools"`. A text-only model then fails at request time with the provider's 400/404, which the new error text explains.
  - D3, the default provider stays `dahl`. OpenRouter is opt-in via `LLM_PROVIDER=openrouter`.
  - D4, the key lives only in env (`OPENROUTER_API_KEY`, trimmed, blank = missing). It is never added to `LlmConfig`, logs or `/api/health`. The engine already scrubs the key out of error bodies.
  - D5, out of scope: OpenRouter-specific request extras (`provider` routing, `models` fallback list, `reasoning` params, `usage.cost` accounting) and prompt caching. Note them in the README as limitations.

## Tasks

### Phase 1: Config and engine seam

- [x] **Task 1: Add the `openrouter` provider to the runtime config.**
  Files: `server/src/config.ts`, `server/src/__tests__/config.test.ts`.
  - Add `{ provider: "openrouter"; model: string; baseURL: string }` to the `LlmConfig` union.
  - Add `DEFAULT_OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1"` and `DEFAULT_OPENROUTER_MODEL = "anthropic/claude-opus-5.5"`.
  - Add `openRouterApiKey(env = process.env)`: `OPENROUTER_API_KEY` trimmed, blank → `undefined`.
  - `resolveLlmConfig`: on `raw === "openrouter"`, read `OPENROUTER_MODEL` (trimmed, default) and `OPENROUTER_BASE_URL` (trimmed, trailing `/` stripped, default). Update the unknown-provider error to `LLM_PROVIDER must be "dahl", "anthropic", "ollama", "gemini" or "openrouter", got "…"`.
  - Add `"env:OPENROUTER_API_KEY" | "openrouter:missing-key"` to `CredentialSource`, with the matching branch in `credentialSource()`. Update the header comment to list OpenRouter.
  - `logConfig()` needs no change: the existing `!== "anthropic"` branch already logs `baseURL`.
  - Tests:
    - defaults (`{provider:"openrouter", model: DEFAULT_OPENROUTER_MODEL, baseURL: DEFAULT_OPENROUTER_BASE_URL}`);
    - overrides with whitespace, a trailing slash and a mixed-case provider (`" OpenRouter "`), with the key kept out of the object;
    - update the regex in the existing "rejects an unknown provider" test;
    - `openRouterApiKey` handles missing, blank and trimmed keys.
  - Logging: the existing `logger.debug("llm provider", {provider, model, source})` covers selection. Never log the key.

- [x] **Task 2: Let a provider profile add request headers.**
  Files: `server/src/agent/openai-compat.ts`, `server/src/agent/__tests__/dahl.test.ts` (or `gemini.test.ts`, wherever a profile-level test fits best).
  - `ProviderProfile.headers?: Record<string, string>`, with a doc comment: "Extra request headers (e.g. attribution). Cannot override authorization, content-type or accept."
  - In `openResponse()`, build the headers as `{ ...(profile.headers ?? {}), authorization: \`Bearer ${key}\`, "content-type": "application/json", accept: "text/event-stream" }`.
  - Update the header comment of `openai-compat.ts` to "Dahl, Gemini, OpenRouter".
  - Test: a profile with `headers: {"X-Title": "t", authorization: "evil"}` sends `X-Title: t` and still sends `authorization: Bearer <key>`. This can be asserted through `createOpenAiCompatClient` directly with a fake fetch.
  - Logging: add `headers: Object.keys(profile.headers ?? {})` (names only, never values) to the existing `logger.info("request", …)` meta. DEBUG-level detail is unchanged.

### Phase 2: The OpenRouter provider

- [x] **Task 3: Create the `openrouter.ts` provider wrapper.** (depends on 1, 2)
  File: `server/src/agent/openrouter.ts` (new). Modelled on `gemini.ts`.
  - Header comment: what OpenRouter is, the endpoint, the Bearer key, that images go as `image_url` data URLs, and that attribution headers are sent.
  - `export type OpenRouterConfig = Extract<LlmConfig, { provider: "openrouter" }>`, `export type OpenRouterClientOptions = OpenAiCompatOptions`.
  - Error classes `OpenRouterApiError extends ChatApiError`, `OpenRouterConnectionError extends ChatConnectionError`, and `OpenRouterMissingKeyError extends ChatMissingKeyError` (message `"OPENROUTER_API_KEY is not set"`).
  - `export const OPENROUTER_ATTRIBUTION = { "HTTP-Referer": "https://github.com/amamei/SplitBill", "X-Title": "SplitBill A2UI" }`.
  - `createOpenRouterClient(llm, opts = {})` calls `createOpenAiCompatClient(llm, { label: "openrouter", apiKey: openRouterApiKey, allowImages: true, headers: OPENROUTER_ATTRIBUTION, errors: {…} }, opts)`.
  - Logging: `logger.info("client", { model, baseURL, keyPresent, vision: true })` with the `agent.openrouter` scope, the same shape as Gemini. Never log the key.

- [x] **Task 4: Route OpenRouter through the LLM seam: client, error texts, preflight.** (depends on 3)
  File: `server/src/agent/llm.ts`.
  - `createAgentClient`: `if (llm.provider === "openrouter") return createOpenRouterClient(llm);`. `createLlmClient` keeps its `Extract<…"anthropic" | "ollama">` narrowing, so no change is needed there. Update the file and function header comments.
  - `supportsVision`: the logic is unchanged (`!== "dahl"`). Update the doc comment: OpenRouter is assumed vision-capable, and the preflight warns otherwise (D2).
  - `describeOpenRouterError(err, llm)` returns Russian chat texts:
    - missing key: «Не задан OPENROUTER_API_KEY. Добавьте ключ из https://openrouter.ai/keys в .env и перезапустите сервер.»
    - `UnsupportedContentError`: «OpenRouter не принял часть сообщения (…) — опишите чек текстом.»
    - connection: «Нет соединения с OpenRouter (baseURL): … Проверьте сеть и повторите.»
    - 401: «OpenRouter не принял ключ (401). Проверьте OPENROUTER_API_KEY…»
    - 402: «На счёте OpenRouter закончились кредиты (402). Пополните баланс…»
    - 403: «OpenRouter отклонил запрос модерацией (403): …»
    - 404: «Модель {model} не найдена в OpenRouter («…»). Задайте в OPENROUTER_MODEL id из https://openrouter.ai/models.»
    - 400 whose message matches `/tool|image|vision|modalit/i`: «Модель {model} не поддерживает инструменты или изображения — выберите другую в OPENROUTER_MODEL.»
    - other 400: «Некорректный запрос к OpenRouter: …»
    - 408: «OpenRouter не дождался ответа модели (408), повторите.»
    - 429: «Слишком много запросов к OpenRouter (429), попробуйте через минуту.»
    - ≥500: «Провайдер модели в OpenRouter недоступен ({status}), повторите через пару секунд.»
    - fallback: «Ошибка OpenRouter {status}: …»
  - Add the branch to `describeLlmError`.
  - `preflightOpenRouter(llm, { apiKey?, fetchImpl? })` returns `OpenRouterPreflightResult { reachable, keyPresent, keyAccepted: boolean | null, modelListed, tools: boolean | null, vision: boolean | null, warnings }`. Logs, never throws.
    1. No key: warn «OPENROUTER_API_KEY не задан — чат будет отвечать ошибкой…».
    2. `GET ${baseURL}/models` without auth, 5 s timeout. On ok, find `data[].id === llm.model`. If missing, warn «модели … нет в OpenRouter /models (задайте OPENROUTER_MODEL)». If found, set `tools = supported_parameters.includes("tools")` and `vision = architecture.input_modalities.includes("image")`. Without tools, warn «модель … без tools — агент работать не сможет». Without image input, warn «модель … без vision — загрузка фото (S9) не будет работать». A non-ok reply gives the warning `OpenRouter ответил {status} на /models`, and a network error the warning `OpenRouter недоступен по …`.
    3. Key present and reachable: `GET ${baseURL}/key` with Bearer, 5 s timeout. 401 → `keyAccepted = false` with a warning. ok → `keyAccepted = true`, and read only `data.limit_remaining` / `data.is_free_tier` for the ready log. Anything else → `null` (debug log).
  - Logging:
    - `logger.debug("preflight raw", { path, status })` for each call;
    - `logger.warn("openrouter preflight", { warning })` per warning;
    - `logger.info("openrouter ready", { model, tools, vision, keyAccepted, limitRemaining, freeTier })` when the key is present and accepted (or `null`), and the model is listed;
    - `logger.debug("preflight key check failed", { err })` on a network error.
    - Never log the key or the full `/key` body.

- [x] **Task 5: Wire startup and scripts.** (depends on 4)
  - `server/src/http/server.ts`: import `preflightOpenRouter` and add `if (config.llm.provider === "openrouter") void preflightOpenRouter(config.llm);` next to the other preflights (around line 202). `/api/health` needs no change: it returns `provider`, `model` and `vision: supportsVision(llm)`.
  - `server/scripts/count-prompt-tokens.ts`: extend the OpenAI-compatible branch to `"openrouter"`. Name `OpenRouter`, key `openRouterApiKey()`, missing-key text `OPENROUTER_API_KEY не задан…`. Replace the chained ternaries with a small `{ name, key, envVar }` lookup keyed by provider so a third provider stays readable. Also send the attribution headers (import `OPENROUTER_ATTRIBUTION`).
  - `smoke-s1.ts` and `bench-s1.ts` already print `config.llm.provider` / `model`, so no change. `probe-dahl.ts` stays Dahl-only.
  - Logging: no new runtime logs beyond Task 4. The script keeps its single JSON output line.

### Phase 3: Tests

- [x] **Task 6: Write `openrouter.test.ts`, mirroring `gemini.test.ts`.** (depends on 3, 4)
  File: `server/src/agent/__tests__/openrouter.test.ts` (new). Reuse the fake-fetch / SSE helpers pattern from `gemini.test.ts` (copy locally, as gemini.test.ts does).
  - Seam: `createAgentClient(LLM)` has `toolRunner`; `supportsVision(LLM) === true`; `providerParams` is a plain system block.
  - `runTurn` end-to-end:
    - a tool call followed by an answer goes to `${baseURL}/chat/completions` with `authorization: Bearer KEY`, `HTTP-Referer` and `X-Title`, with `stream: true` and `stream_options.include_usage`;
    - a receipt photo is sent as an `image_url` data URL;
    - an SSE comment line `: OPENROUTER PROCESSING` before the first data line is ignored (B3).
  - Errors:
    - missing key → `OpenRouterMissingKeyError`, no request made;
    - a 402 body `{"error":{"code":402,"message":"Insufficient credits"}}` → `OpenRouterApiError` with that message and no key leak;
    - a mid-stream error chunk `{"error":{"code":502,"message":"Provider returned error"},"choices":[{"delta":{},"finish_reason":"error"}]}` → `OpenRouterApiError` with status 502 (B2);
    - a 503 is retried, then gives up;
    - a network failure → `OpenRouterConnectionError`;
    - an `OpenRouterApiError` is not a `DahlApiError` / `GeminiApiError`.
  - `describeLlmError` for 401, 402, 403, 404, 408, 429, 502, the missing key and connection errors (assert key phrases).
  - `preflightOpenRouter`:
    - no key → one warning and no `/key` call;
    - model listed with tools and image → ready, no warnings, `keyAccepted: true`;
    - model listed without `"image"` → a vision warning; without `"tools"` → a tools warning;
    - model not listed → a warning;
    - `/key` 401 → `keyAccepted: false`;
    - `/models` network error → `reachable: false`;
    - the key never appears in any warning.
  - Run `npm -w server test` and `npm run typecheck`. Both must be green, including the existing Dahl/Gemini suites, which must stay unchanged apart from Task 1's regex and Task 2's header test.
  - Logging: tests run with `LOG_LEVEL=error` (server test script). No log assertions are needed.

### Phase 4: Docs and live check

- [x] **Task 7: Update the docs for the new provider.** (depends on 5)
  - `.env.example`: add `openrouter` to the provider list line. Add a block:
    ```
    # --- openrouter: only with LLM_PROVIDER=openrouter (one key, many models; reads receipt photos with vision models) ---
    # Key from https://openrouter.ai/keys. Keep it in .env only.
    # OPENROUTER_API_KEY=
    # OPENROUTER_MODEL=anthropic/claude-opus-5.5   # cheaper: google/gemini-2.5-flash; list: curl https://openrouter.ai/api/v1/models
    # OPENROUTER_BASE_URL=https://openrouter.ai/api/v1
    ```
  - `README.md` (Russian, matching the existing style):
    - line 5 (alternatives list) and line 11 (prerequisites): mention OpenRouter;
    - a new section `## Модель через OpenRouter` after the Gemini section. Cover: the same OpenAI-compatible adapter as Dahl/Gemini; the env block; the startup log (`[agent.llm] openrouter ready {tools, vision, …}` or the `openrouter preflight` warnings); `/api/health` → `{"provider":"openrouter","model":"anthropic/claude-opus-5.5","vision":true}`; the vision caveat (D2); limitations (no prompt cache, effort, fallbacks or provider routing, D5); the chat error texts from Task 4;
    - env table rows for `OPENROUTER_API_KEY`, `OPENROUTER_MODEL` and `OPENROUTER_BASE_URL`, and `openrouter` in the `LLM_PROVIDER` row;
    - the troubleshooting table: a row for 402 (credits) and 404 (model id).
  - `docs/DEMO.md`: in line 5 (prerequisites), mention `LLM_PROVIDER=openrouter` + `OPENROUTER_API_KEY`. In line 83 (S9 vision), add OpenRouter with a vision model to the list.
  - Logging: n/a (docs).

- [ ] **Task 8: Live check with a real key (manual; skip and report if no key).** (depends on 6, 7)
  - With `LLM_PROVIDER=openrouter` and `OPENROUTER_API_KEY` in `.env`:
    1. `npm run dev` (or the server start script). Check the `openrouter ready` log and `curl localhost:8787/api/health`.
    2. `npm -w server run smoke:s1`: the S1 surface renders through tool calls.
    3. `npm -w server run count:prompt`: prints `inputTokens`.
    4. One S9 photo upload with the default (vision) model.
  - Record the outcome of B1 (usage present in the bench/smoke output), B2/B4 (only if an error was hit) and B5 (preflight `keyAccepted: true`) in the commit message body. If any assumption is wrong, fix it in `openrouter.ts` / `llm.ts` with a regression test before committing.
  - If no key is available: leave this task unchecked, and say so in the final summary with the exact commands above.
  - Logging: the server logs at `LOG_LEVEL=debug` show `agent.openrouter` `request` / `first byte` / `stream done` (with `usage`) for each model call. Attach the relevant excerpt (without the key) to the report.

## Commit Plan

- **Commit 1** (after Tasks 1–2): `feat(server): openrouter provider config and per-profile request headers`
- **Commit 2** (after Tasks 3–6): `feat(server): OpenRouter provider over the OpenAI-compatible engine, with preflight and error texts`
- **Commit 3** (after Tasks 7–8): `docs: run on OpenRouter`
