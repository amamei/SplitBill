# Implementation Plan: Local Ollama models as an alternative agent backend

Branch: feature/a2ui-ollama-support (created from `feature/a2ui-clear-bill`; the repo has no `main`)
Created: 2026-10-04

## Original Request
add support of ollama ai models, add instructions

## Settings
- Testing: yes
- Logging: verbose
- Docs: yes  # mandatory docs checkpoint in /aif-implement; instructions go to a2ui/README.md only (user choice: README section, no .env.example / REPORT.md changes)

## Design Summary

- **Approach: reuse the Anthropic SDK against Ollama's Anthropic-compatible API.** Ollama (≥ 0.14) serves `POST /v1/messages`. The whole agent stays on `@anthropic-ai/sdk`: `client.beta.messages.toolRunner`, `betaZodTool`, `ToolError`, streaming events, `BetaMessageParam` history. Only the client construction and a few request params change. Rejected alternative: an OpenAI-compatible client (`/v1/chat/completions`). It would mean rewriting `runner.ts`, `tools.ts`, the history type in `session.ts`, the streaming bridge and the tests.
- **Evidence (manual curl against the local Ollama 0.35.1 with `qwen3.6:35b-a3b-q4_K_M`, 2026-10-04):**
  - `POST /v1/messages?beta=true` (the beta tool runner's URL) with `stream:true`, a tool, `system[].cache_control`, `output_config.effort` and an `anthropic-beta` header → 200. The stream contains `message_start` / `content_block_start{tool_use}` / `input_json_delta` / `message_delta{stop_reason:"tool_use"}`. The unknown fields are silently ignored.
  - Replaying an assistant turn with an unsigned `thinking` block + `tool_use`, then a user `tool_result` → 200, normal `end_turn` reply. So the tool-runner loop works.
  - Tool input arrives in **one** `input_json_delta` (not incremental). The S10 progressive render degrades to "whole tree at once". This is a known limitation, not a bug.
  - Unknown model → 404 `{"type":"error","error":{"type":"not_found_error","message":"model 'nope:1b' not found"}}` → SDK `NotFoundError`.
  - Server not running → connection refused → SDK `APIConnectionError`.
  - `POST /v1/messages/count_tokens` → 404 (not supported).
  - `usage` reports `input_tokens` / `output_tokens`, `cache_read_input_tokens: 0`. There is no prompt cache.
  - Default loaded context was 32768 (`ollama ps`). The system prompt alone is ~21k tokens (REPORT), and an S1 tree is ~5k output tokens. The instructions must ask for ≥ 65536 (`OLLAMA_CONTEXT_LENGTH`).
- **Selection: one env switch, default unchanged.**
  - `LLM_PROVIDER=anthropic|ollama` (default `anthropic`, the TZ §3 shared model).
  - With `ollama`, `OLLAMA_MODEL` is required, and `OLLAMA_BASE_URL` defaults to `http://localhost:11434`.
  - Nothing changes in the web client, and there is no per-session or UI switch (user choice).
- **Ollama request shape (per provider, built by one pure function):**
  - Omit `output_config.effort`, `betas` and `fallbacks`, and the `cache_control` on the system block. Ollama ignores them anyway; leaving them out keeps the logs and telemetry honest.
  - Keep `max_tokens: 32000`, `stream: true`, the tools and the history.
- **Client:**
  - `new Anthropic({ baseURL: OLLAMA_BASE_URL, apiKey: "ollama", authToken: null })`.
  - An explicit `apiKey` skips the `ant` profile resolution. `authToken: null` keeps a stray `ANTHROPIC_AUTH_TOKEN` from adding a Bearer header.
  - Never pass any Anthropic secret to the Ollama URL.
- **Startup preflight (non-fatal):** for `ollama`, `GET {base}/api/show {model}` checks four things. Each problem is logged as a `warn` with a fix hint, and the server still starts.
  - Is the server reachable?
  - Is the model pulled?
  - Do its `capabilities` include `tools`? Without tools the app cannot work.
  - Do they include `vision`? Without it S9 photo upload does not work.
- **Errors in chat (Russian, like the existing ones), Ollama-specific:**
  - Connection refused → «Ollama недоступна по <url>. Запустите `ollama serve` (или приложение Ollama) и повторите.»
  - Model not found → «Модель <m> не найдена в Ollama. Выполните `ollama pull <m>`.»
  - "does not support tools" / "image" in a 400 → «Модель <m> не поддерживает инструменты / изображения — выберите другую модель.»
  - The Anthropic messages stay exactly as they are.
- **Out of scope:**
  - other providers (OpenAI, Gemini…);
  - a model picker in the UI;
  - auto-pulling models;
  - setting `num_ctx` per request (the Anthropic-compatible API has no field for it);
  - REPORT.md numbers for the local model, because it is not the TZ shared model.

## Requirements Reconciliation
Authority: the user request plus the clarification answers (full plan, tests yes, env switch with the default kept on Anthropic, instructions in README only). TZ §3 ("one shared model for all participants") makes Anthropic the default; Ollama is opt-in for local and offline runs and is documented as outside the comparison.

| `LLM_PROVIDER` | Other env | Expected behavior | Verification |
|---|---|---|---|
| unset / `anthropic` | `ANTHROPIC_*` as today | Identical request params to today (effort, cache_control, fallbacks when on). Same credentials and errors. No preflight. | Unit test on params (Task 3) + existing runner tests still pass |
| `ollama` | `OLLAMA_MODEL` set, server up, model has tools | Turns run through Ollama. The params have no effort/betas/fallbacks/cache_control. `/api/health` → `{provider:"ollama", model}`. Telemetry `model` = the Ollama model. | Unit tests (Tasks 1, 3) + manual `smoke:s1` on `qwen3.6:35b-a3b-q4_K_M` (Task 6) |
| `ollama` | `OLLAMA_MODEL` missing | Startup fails fast with an error naming `OLLAMA_MODEL` and `ollama list` | Unit test on `resolveLlmConfig` (Task 1) |
| `ollama` | server down | The server starts, the preflight warns, and a chat turn shows the "Ollama недоступна" error in chat | Unit test on the error mapping (Task 3) + manual (Task 6) |
| `ollama` | model not pulled | The preflight warns. A turn shows «… `ollama pull <m>`». | Unit tests (Tasks 2, 3) |
| `ollama` | model without `tools` / `vision` | Preflight `warn` (tools: the app will not work; vision: S9 will not work) | Unit test on the capability check (Task 2) |
| any other value | — | Startup fails fast: `LLM_PROVIDER must be "anthropic" or "ollama"` | Unit test (Task 1) |

## Commit Plan
- **Commit 1** (after tasks 1-3): `feat(server): Ollama provider via the Anthropic-compatible API`
- **Commit 2** (after tasks 4-6): `docs(a2ui): run with a local Ollama model; scripts aware of the provider`

## Tasks

### Phase 1: Provider plumbing (server)

- [x] Task 1: Provider config in `a2ui/server/src/config.ts`.
  - **Pure resolver.** Add an exported `resolveLlmConfig(env: NodeJS.ProcessEnv)` returning `LlmConfig`, a discriminated union:
    - `{ provider: "anthropic"; model; effort; fallbacks }` — the current values and defaults, unchanged;
    - `{ provider: "ollama"; model; baseURL }`.
  - **Validation:**
    - An unknown `LLM_PROVIDER` throws `Error('LLM_PROVIDER must be "anthropic" or "ollama", got "<v>"')`.
    - `ollama` without `OLLAMA_MODEL` throws `Error("LLM_PROVIDER=ollama needs OLLAMA_MODEL (see `ollama list`), e.g. OLLAMA_MODEL=qwen3.6:35b-a3b-q4_K_M")`.
    - Trim trailing `/` from `OLLAMA_BASE_URL` (default `http://localhost:11434`).
    - Matching is case-insensitive, and the value is trimmed.
  - **`config` object:**
    - `config.llm = resolveLlmConfig(process.env)`.
    - Keep `config.model` as an alias of `config.llm.model`; `config.effort` / `config.fallbacks` stay for the anthropic path and the scripts. That way `server.ts`, `bench-s1.ts` and the telemetry keep compiling.
  - **Credentials and logging:**
    - `credentialSource()` returns the new label `"ollama:none"` when the provider is ollama. Extend the `CredentialSource` type.
    - `logConfig()` logs `provider` and `baseURL` (never secrets).
  - **Header comment:** update it ("defaults + the `ant` CLI profile, or a local Ollama").
  - **LOGGING** (scope `config`):
    - `info("resolved", {..., provider, baseURL?})`;
    - `debug("llm provider", { provider, model, source: "LLM_PROVIDER" | "default" })`.
  - **Tests:** new `a2ui/server/src/__tests__/config.test.ts` (node:test, `node:assert/strict`), passing explicit env objects and never mutating `process.env`. Cases:
    1. Empty env → anthropic, `claude-opus-5-5`, effort `medium`, fallbacks `true`.
    2. `ANTHROPIC_FALLBACKS=off` → fallbacks `false`.
    3. `LLM_PROVIDER=ollama, OLLAMA_MODEL=m` → `baseURL` is the default, model `m`.
    4. `LLM_PROVIDER=Ollama, OLLAMA_BASE_URL=http://h:1/` → `baseURL` `http://h:1`.
    5. `ollama` without a model → throws `/OLLAMA_MODEL/`.
    6. `LLM_PROVIDER=gpt` → throws `/LLM_PROVIDER/`.
  - Files: `a2ui/server/src/config.ts`, `a2ui/server/src/__tests__/config.test.ts`.

- [x] Task 2: New module `a2ui/server/src/agent/llm.ts`, holding the client, the per-provider request params, error text and the preflight (depends on 1).
  - **`createLlmClient(llm: LlmConfig): Anthropic`:**
    - anthropic → `new Anthropic()`, exactly today's behavior;
    - ollama → `new Anthropic({ baseURL: llm.baseURL, apiKey: "ollama", authToken: null })`.
    - Add `getLlmClient()`, which memoizes `createLlmClient(config.llm)`. It replaces `getClient()` in `runner.ts`.
  - **`providerParams(llm, system: string)`** returns the provider-dependent part of the toolRunner params:
    - anthropic → `{ system: [{type:"text", text: system, cache_control:{type:"ephemeral"}}], output_config:{effort}, ...(fallbacks ? {betas:["server-side-fallback-2026-07-01"], fallbacks:"default"} : {}) }` (moved verbatim from `runner.ts`);
    - ollama → `{ system: [{ type: "text", text: system }] }`.
    - Type it so the spread into `toolRunner({...})` still typechecks (use the SDK param type `Partial<BetaToolRunnerParams>` or the exact keys).
  - **`describeLlmError(err, llm): string`.** Move `describeError`, `isMissingCredentials` and the `TruncatedToolInput` check from `runner.ts`; export `TruncatedToolInput` from here. For `ollama`, check before the generic branches:
    - `Anthropic.APIConnectionError` → the "Ollama недоступна по <baseURL>…" text;
    - `Anthropic.NotFoundError` with `/not found/i` → the "`ollama pull <model>`" text;
    - `Anthropic.BadRequestError` with `/does not support tools/i` → the tools text;
    - `/image|vision/i` in a 400 → the vision text;
    - anything else falls through to the generic `APIError` text.
    - The Anthropic branches stay byte-identical.
  - **`preflightOllama(llm, fetchImpl = fetch): Promise<PreflightResult>`:**
    - `POST {baseURL}/api/show` with `{ model }` and a 3 s timeout (`AbortSignal.timeout`).
    - Returns `{ reachable, found, capabilities: string[], warnings: string[] }`. It never throws.
    - Warnings:
      - unreachable → "Ollama недоступна по <url>: запустите `ollama serve`";
      - 404 → "модель не скачана: `ollama pull <m>`";
      - no `tools` → "модель без tools — агент работать не сможет";
      - no `vision` → "без vision — загрузка фото (S9) не будет работать".
    - Add a hint that context should be ≥ 65536, pointing to the README, logged once at `info`. The API cannot read the loaded `num_ctx`, so this is a hint, not a check.
  - **LOGGING** (scope `agent.llm`):
    - `info("client", { provider, baseURL? })` on first creation;
    - `debug("request params", { provider, keys: Object.keys(params) })`;
    - in the preflight, `info("ollama ready", { model, capabilities })`, or one `warn` per warning, plus `debug("preflight raw", { status })`.
  - **Tests:** new `a2ui/server/src/agent/__tests__/llm.test.ts`:
    1. `providerParams` for anthropic (fallbacks on and off) matches today's shape. For ollama it has no `output_config` / `betas` / `fallbacks`, and the system block has no `cache_control`.
    2. `describeLlmError` for ollama:
       - `new Anthropic.APIConnectionError({ message: "Connection error." })` → contains the base URL and `ollama serve`;
       - `Anthropic.APIError.generate(404, { type: "error", error: { type: "not_found_error", message: "model 'x' not found" } }, undefined, new Headers())` → contains `ollama pull x`;
       - a 400 with "does not support tools" → the tools text.
    3. `describeLlmError` for anthropic: the `AuthenticationError` text is unchanged.
    4. `preflightOllama` with a stubbed `fetchImpl`:
       - 200 `{capabilities:["completion","tools"]}` → warns about vision only;
       - 404 → a pull warning;
       - fetch rejects → unreachable;
       - `["completion","vision","tools"]` → no warnings.
  - Files: `a2ui/server/src/agent/llm.ts`, `a2ui/server/src/agent/__tests__/llm.test.ts`.

- [x] Task 3: Wire the provider into the runner, the health endpoint and startup (depends on 2).
  - **`a2ui/server/src/agent/runner.ts`:**
    - Replace `getClient()` with `getLlmClient()`.
    - Add `opts.llm?: LlmConfig` (default `config.llm`) next to `opts.client`, so tests can drive the ollama shape.
    - Build `toolRunner({ model: llm.model, max_tokens: 32000, tools, messages, stream: true, ...providerParams(llm, buildSystemPrompt()) })`.
    - Use `describeLlmError(err, llm)`.
    - The rest is unchanged: retries, the refusal branch, the `message.model !== llm.model` fallback detection, and history.
    - Update the header comment ("Claude or a local Ollama model, same tool runner").
    - Add `provider` to the `logger.info("start", …)` payload.
    - In the error log, keep the status (`APIConnectionError` has `status` undefined, which is fine).
  - **`a2ui/server/src/http/server.ts`:**
    - `/api/health` returns `{ ok: true, provider: config.llm.provider, model: config.model }`.
    - In the `isMain` block after `logConfig()`, when the provider is ollama, run `void preflightOllama(config.llm)`. It logs on its own; do not await it before `listen`.
  - **Tests,** extending `a2ui/server/src/agent/__tests__/runner.test.ts` with the existing `stubClient()`:
    1. `runTurn(session, "привет", { client, llm: { provider: "ollama", model: "m", baseURL: "http://x" } })`:
       - `calls[0]` has `model === "m"` and no `output_config` / `betas` / `fallbacks`;
       - `system[0]` has no `cache_control`;
       - `telemetry.model === "m"`.
    2. With an explicit anthropic `llm`, `calls[0].output_config.effort` is set and `system[0].cache_control` exists. This pins today's behavior.
    3. A stub whose iterator throws `new Anthropic.APIConnectionError({message:"Connection error."})` under the ollama `llm`:
       - the `error` event text mentions `ollama serve`;
       - `session.busy === false` and the history is rolled back.
  - Run `npm -w server test` and `npm -w server run typecheck`.
  - **LOGGING:**
    - `agent.turn` `start` includes `provider`;
    - `http.server` logs nothing new beyond the preflight's own lines.
  - Files: `a2ui/server/src/agent/runner.ts`, `a2ui/server/src/http/server.ts`, `a2ui/server/src/agent/__tests__/runner.test.ts`.

<!-- Commit checkpoint: tasks 1-3 -->

### Phase 2: Scripts and instructions

- [x] Task 4: Make the live-model scripts provider-aware (depends on 3).
  - **`a2ui/server/scripts/count-prompt-tokens.ts`:**
    - Use `createLlmClient(config.llm)`.
    - Anthropic keeps `messages.countTokens`.
    - Ollama has no `count_tokens` endpoint (404), so send `messages.create({ model, max_tokens: 1, system, messages:[{role:"user",content:"Привет"}] })` and report `usage.input_tokens`. The output adds `provider` and `method: "countTokens" | "usage(max_tokens=1)"`.
    - Update the header comment.
  - **`a2ui/server/scripts/smoke-s1.ts`:** update the header comment (works with `LLM_PROVIDER=ollama`), and print `provider` / `model` before the table.
  - **`a2ui/server/scripts/bench-s1.ts`:** record `provider: config.llm.provider` next to `model` in the written JSON, and keep `effort` only for anthropic (`undefined` for ollama).
  - Run `npm -w server run typecheck` (covers `tsconfig.scripts.json`).
  - **LOGGING:** the scripts use `console` as today; there is nothing to add beyond the printed `provider`.
  - Files: `a2ui/server/scripts/count-prompt-tokens.ts`, `a2ui/server/scripts/smoke-s1.ts`, `a2ui/server/scripts/bench-s1.ts`.

- [x] Task 5: README instructions, «Локальная модель через Ollama» (depends on 3, 4). Write in Russian, matching the README, and place it after «Запуск одной командой». Content:
  1. **Requirements:**
     - Ollama ≥ 0.14 (the version with the Anthropic-compatible `/v1/messages`); tested on 0.35.1.
     - A model with `tools` (required) and `vision` (for S9 photos); check with `ollama show <model>` → Capabilities.
     - Tested: `qwen3.6:35b-a3b-q4_K_M` (~23 GB, Apple Silicon GPU).
     - A smaller model works but renders the A2UI tree less reliably.
  2. **Install and pull:** `brew install ollama` (or the app from ollama.com), then `ollama pull qwen3.6:35b-a3b-q4_K_M`.
  3. **Context window (mandatory):**
     - The system prompt is ~21k tokens and the S1 tree ~5k output tokens, while Ollama's default loaded context may be 32k.
     - Run with `OLLAMA_CONTEXT_LENGTH=65536 ollama serve`.
     - Alternatives: the Ollama app's settings slider; `launchctl setenv OLLAMA_CONTEXT_LENGTH 65536` and restart the app (macOS); or a Modelfile with `PARAMETER num_ctx 65536` + `ollama create`.
     - Verify with `ollama ps` → the CONTEXT column.
  4. **`.env` block:** `LLM_PROVIDER=ollama`, `OLLAMA_MODEL=…`, `# OLLAMA_BASE_URL=http://localhost:11434`. `ANTHROPIC_*` are ignored in this mode, and no key is needed.
  5. **Run and check:**
     - `npm run dev`;
     - the server log line `config resolved … provider: "ollama"` and `ollama ready`, or a warning with its fix;
     - `curl localhost:8787/api/health` → `{"provider":"ollama",…}`;
     - `npm -w server run smoke:s1`.
     - Switch back by removing `LLM_PROVIDER` or setting `anthropic`.
  6. **Limitations:**
     - no prompt cache, so every turn re-reads the ~21k prompt and the first S1 can take minutes on a laptop;
     - `ANTHROPIC_EFFORT` / `ANTHROPIC_FALLBACKS` do not apply;
     - tool input arrives in one piece, so S10 streaming shows the tree at once, not progressively;
     - `count:prompt` is measured via `usage`;
     - quality and validation repairs depend on the model;
     - it is not the TZ §3 shared model, so its numbers do not go into REPORT.md.
  7. **Troubleshooting table:**

     | Message | Cause | Fix |
     |---|---|---|
     | «Ollama недоступна» | the server is not running | `ollama serve` |
     | «`ollama pull`» | the model is missing | pull it |
     | «не поддерживает инструменты» | the model has no `tools` | pick another model |
     | a broken or truncated tree | the context is too small | raise the context |

  - **Also in the README:**
    - add `LLM_PROVIDER`, `OLLAMA_MODEL` and `OLLAMA_BASE_URL` rows to the «Переменные окружения» table;
    - in the intro bullet «Модель», add "или локальная модель через Ollama (`LLM_PROVIDER=ollama`)";
    - in the «Тесты и замеры» block, add a one-line note that `smoke:s1` / `bench:s1` / `count:prompt` use the active provider.
  - Do not edit `.env.example` or `REPORT.md` (user choice).
  - **LOGGING:** n/a (docs).
  - Files: `a2ui/README.md`.

- [x] Task 6: End-to-end verification on the local Ollama (depends on 3, 4, 5). This is a manual step with recorded results and no new code.
  1. Run `npm test && npm run typecheck` in `a2ui/`: everything is green.
  2. `OLLAMA_CONTEXT_LENGTH=65536 ollama serve` (or the app setting); `ollama ps` shows 65536 after the first request.
  3. With `.env` set to `LLM_PROVIDER=ollama` and `OLLAMA_MODEL=qwen3.6:35b-a3b-q4_K_M`, run `npm -w server run count:prompt`. It prints `provider: "ollama"` and an `inputTokens` count.
  4. Run `npm -w server run smoke:s1`. Record PASS/FAIL per check, plus `totalMs` and the tokens for S1/S6, in the final implementation summary, not in REPORT.md. The real-artifact check is the TZ §6 control example: balances +385/+385/−405/−365, and after S6 +465/+425/−365/−525. Numbers are computed by code, so a FAIL there means the model did not call the tools correctly. Note it as a model-quality finding, not a code bug, unless the tool calls were correct.
  5. Run `npm run dev` and use the "Пример из ТЗ" chip in the browser: the bill surface renders, S2–S5 buttons work (no model round trip), and "Новый счёт" still works.
  6. Negative checks:
     - stop Ollama and send a chat message → the chat shows «Ollama недоступна…» and the server stays up;
     - set `OLLAMA_MODEL=nope:1b` and restart → a preflight warning, then «`ollama pull nope:1b`» in chat;
     - remove `OLLAMA_MODEL` → startup fails with the `OLLAMA_MODEL` message.
  7. Remove `LLM_PROVIDER` and restart: `/api/health` shows `provider:"anthropic"`, `claude-opus-5-5`.
  - If S1 does not fit, or the context overflows at 65536, raise the README recommendation and note the finding.
  - **LOGGING:** confirm the `agent.llm` / `config` lines from Tasks 1-3 appear at `LOG_LEVEL=debug`, with no secrets in them.
  - Files: none (results go in the implementation summary; README adjustments only if a finding requires them).

<!-- Commit checkpoint: tasks 4-6 -->
