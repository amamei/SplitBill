# Implementation Plan: Dahl inference API as the default LLM backend

Branch: feature/dahl-llm-api (created from `feature/a2ui-ollama-support`, which already holds the provider seam this plan extends)
Created: 2026-10-09

## Original Request
Switch LLM API to https://inference.dahl.global/docs/api/

## Settings
- Testing: yes
- Logging: verbose
- Docs: yes  # mandatory docs checkpoint in /aif-implement: README.md, .env.example and the prerequisite line in docs/DEMO.md. REPORT.md is not touched.

## Design Summary

- **What Dahl is** (docs at `/docs/api/` and `/docs/models/`, plus public endpoints probed on 2026-10-09):
  - Base URL `https://inference.dahl.global/v1`, `Authorization: Bearer <key>`. The docs name the variable `DAHL_API_KEY`.
  - OpenAI request shape only. `POST /v1/chat/completions` with SSE streaming (`data: {…}` lines, `data: [DONE]`), plus a thin `POST /v1/responses` adapter. **There is no Anthropic-compatible endpoint**, so the Ollama trick (same SDK, other `baseURL`) does not work here.
  - `GET /v1/models` (public) returned three live models: `MiniMaxAI/MiniMax-M2.7` (180K context, the docs' default), `deepseek-ai/DeepSeek-V4-Flash-0731` and `zai-org/GLM-5.3-Flash` (both 400K, reasoning). Tool calling is documented for MiniMax and DeepSeek Flash. **No vision on any model.**
  - Errors: 401 missing/invalid key, 402 tokens exhausted, 429 too many signup/sign-in attempts, 400 "This model is not currently offered" (the message lists the live IDs), 503/timeout = retry with a short backoff. Bodies are described by message text only. An unauthenticated `POST /v1/chat/completions` returned `401` with a JSON body.
  - **Not verifiable without a key (none in this environment)**, so these are assumptions A1–A7, checked by Task 2 and re-checked in Task 9: streaming usage chunk, tool-call delta granularity, where reasoning text goes, finish reasons, `max_tokens: 32000`, acceptance of the tool schemas, error body shape.
- **Approach: an Anthropic-shaped adapter over chat completions.**
  - `runner.ts`, `tools.ts`, `session.ts`, `render-stream.ts` and their tests all consume the Anthropic shapes: the `client.beta.messages.toolRunner(params)` surface (async iterator of streams, each an iterator of events with `finalMessage()`), `BetaMessageParam` history, and `betaZodTool` tools.
  - One new module (`agent/dahl.ts`) exposes the same `toolRunner` surface, backed by `fetch` to Dahl. It converts the history and tools to OpenAI messages, turns SSE chunks into Anthropic-style events, and runs the tool loop itself (reusing the SDK's `runRunnableTool`, so `ToolError` and error results behave exactly as before).
  - Pure conversion functions live in `agent/dahl-wire.ts` so they are testable without a network.
  - The seam is the existing `ClaudeClient = Pick<Anthropic, "beta">` type that tests already stub. The adapter returns that type through one documented `as unknown as` cast, and an end-to-end `runTurn` test through the adapter guards against shape drift.
  - Rejected: the `openai` npm SDK (new dependency, no help with our event contract, v7 API not verifiable offline); rewriting runner/tools/history for OpenAI (touches ~10 files, breaks the Anthropic and Ollama paths, and the user did not choose "replace"); `/v1/responses` (a thin adapter with no stored state, less documented than chat completions).
  - Transport is plain `fetch` + a small SSE parser, the same pattern as `preflightOllama`.
- **Selection:** `LLM_PROVIDER=dahl|anthropic|ollama`, **default `dahl`** (user choice). Anthropic and Ollama stay selectable and untouched. Env: `DAHL_API_KEY` (secret), `DAHL_MODEL` (default `MiniMaxAI/MiniMax-M2.7`), `DAHL_BASE_URL` (default `https://inference.dahl.global/v1`).
- **A missing `DAHL_API_KEY` is not fatal at config time.** `config.ts` is imported by every module and every test, and the default is now `dahl`, so a throw would break `npm test` and any run without a key. Instead: a startup `warn`, and the first chat turn fails with a clear Russian message **without a network call**. The key is never stored in `LlmConfig` or `config` (so `logConfig` cannot leak it); it is read through `dahlApiKey()`.
- **Request mapping (Anthropic params → OpenAI body):**
  - `system` blocks → one leading `{role:"system"}` message.
  - `tools` → `[{type:"function", function:{name, description, parameters}}]`. `parameters` is the zod JSON schema with `$schema` dropped and local `$ref`/`$defs` inlined (`SplitInput` is shared, so zod emits `$defs`). `eager_input_streaming` is dropped.
  - `messages` → assistant text + `tool_use` become `content` + `tool_calls[{id, type:"function", function:{name, arguments: JSON string}}]`. A user `tool_result` block becomes `{role:"tool", tool_call_id, content}`. User text blocks (state-sync block + text) are joined into one user message.
  - Body: `model`, `max_tokens: 32000`, `stream: true`, `stream_options: {include_usage: true}`. No `tool_choice`, no temperature.
  - An `image` block throws `UnsupportedContentError` (no vision).
- **Stream mapping (OpenAI chunks → Anthropic events):**
  - `delta.content` → `content_block_start{text}` + `text_delta`, with `<think>…</think>` spans stripped.
  - `delta.reasoning_content` / `reasoning` → ignored (counted in a debug log).
  - `delta.tool_calls[i]` → `content_block_start{tool_use}` + `input_json_delta` fragments, keyed by the OpenAI `index`. A different `id` on a reused index starts a new block; a missing `id` is synthesized.
  - `finish_reason`: `tool_calls`→`tool_use`, `length`→`max_tokens`, `content_filter`→`refusal`, otherwise `end_turn` (or `tool_use` if tool calls were seen).
  - `usage` → `{input_tokens: prompt_tokens − cached, output_tokens: completion_tokens, cache_read_input_tokens: prompt_tokens_details.cached_tokens ?? 0, cache_creation_input_tokens: 0}` (OpenAI's `prompt_tokens` includes cached tokens, Anthropic's `input_tokens` does not, so telemetry stays comparable).
  - `finalMessage().model` is always the requested model, so `runner.ts`'s "served by a fallback" detection never fires falsely.
- **Photo upload (S9) is disabled on Dahl** (no vision on any model): `POST /api/upload` answers `422 NO_VISION` with a Russian message that `Chat.tsx` already shows (it prints `json.error.message`). `/api/health` gains `vision: boolean`. No web changes.
- **Known limitations, documented, not bugs:**
  - No prompt cache, no effort control, no refusal fallback.
  - Tool-call arguments may arrive in one piece, so the S10 progressive render can degrade to "whole tree at once" (the same effect as Ollama). To be measured in Task 9.
  - The hosted network's latency is variable, so there is an idle timeout and a short retry.
  - Quality of A2UI trees depends on MiniMax-M2.7.
- **Out of scope:**
  - removing the Anthropic/Ollama providers or the Anthropic SDK;
  - a model picker in the UI;
  - `/v1/responses`;
  - re-measuring REPORT.md on Dahl (a follow-up if Dahl is the shared model for the TZ §3 comparison);
  - OCR as a vision substitute;
  - editing the user's `.env`.

## Requirements Reconciliation
Authority: the user request plus the clarification answers (add `dahl` and make it the default; MiniMax-M2.7 default model; tests yes; docs yes). The Dahl API docs are the contract for the wire format. TZ §3 ("one shared model for all participants") is the reason the provider is selected by one env switch. The previous plan (`feature-a2ui-ollama-support.md`) is the contract for the Anthropic and Ollama paths, which must stay behavior-identical.

| `LLM_PROVIDER` | Other env / input | Expected behavior | Verification |
|---|---|---|---|
| unset / `dahl` | `DAHL_API_KEY` set, model offered | Turns run through the adapter. Telemetry `model` = `DAHL_MODEL`. `/api/health` → `{provider:"dahl", model, vision:false}`. | Unit + e2e tests (Tasks 3, 4, 6); `smoke:s1` (Task 9) |
| unset / `dahl` | `DAHL_API_KEY` missing or blank | Server starts; preflight `warn`. A chat turn fails with «Не задан DAHL_API_KEY…» and **no HTTP request**. History is rolled back. | Tests (Tasks 4, 5, 6); manual (Task 9) |
| `dahl` | 401 / 402 / 429 / 503 / connection error / timeout | A Russian chat error per status (Task 5). 503, network errors and timeouts before the first byte are retried 2× (500 ms, 1500 ms). | Tests with a stubbed `fetch` (Tasks 4, 5) |
| `dahl` | 400 "model is not currently offered" | The chat error names the model and lists the live IDs from the message, and points to `DAHL_MODEL`. | Test (Task 5); manual with `DAHL_MODEL=nope` (Task 9) |
| `dahl` | `POST /api/upload` (image) | `422 NO_VISION` before any model call; the session is untouched. | HTTP test (Task 6); manual (Task 9) |
| `dahl` | the model streams a tool call whose JSON is invalid | Re-issued up to 2× through the existing `isToolJsonError` path; on `length` it surfaces as `TruncatedToolInput`. | Test (Task 3, 4) |
| `anthropic` | `ANTHROPIC_*` as today | Byte-identical request params and error texts to today; needs `LLM_PROVIDER=anthropic` now. | Existing + updated tests (Tasks 1, 5, 6) |
| `ollama` | `OLLAMA_MODEL` etc. | Unchanged. | Existing tests |
| any other value | — | Startup fails fast: `LLM_PROVIDER must be "dahl", "anthropic" or "ollama", got "<v>"`. | Test (Task 1) |

## Commit Plan
- **Commit 1** (after tasks 1-2): `feat(server): Dahl provider config and live API probe`
- **Commit 2** (after tasks 3-4): `feat(server): Anthropic-shaped tool-runner adapter over Dahl chat completions`
- **Commit 3** (after tasks 5-7): `feat(server): wire the Dahl provider as the default, with vision guard and preflight` (the provider-aware scripts of Task 7 go here: `count-prompt-tokens.ts` would not typecheck without them)
- **Commit 4** (after tasks 8-9): `docs: run on the Dahl API`

## Tasks

### Phase 1: Config and live-API probe

- [x] Task 1: Provider config in `server/src/config.ts` (no dependencies).
  - **Types and constants:**
    - Add `{ provider: "dahl"; model: string; baseURL: string }` to `LlmConfig`.
    - Export `DEFAULT_DAHL_BASE_URL = "https://inference.dahl.global/v1"` and `DEFAULT_DAHL_MODEL = "MiniMaxAI/MiniMax-M2.7"`.
    - Do **not** put the key in `LlmConfig` or `config`.
  - **`resolveLlmConfig(env)`:**
    - `raw = env.LLM_PROVIDER?.trim().toLowerCase() || "dahl"` (the default flips from `anthropic`).
    - `dahl` → `model = env.DAHL_MODEL?.trim() || DEFAULT_DAHL_MODEL`, `baseURL = (env.DAHL_BASE_URL?.trim() || DEFAULT_DAHL_BASE_URL)` with trailing `/` stripped.
    - The `anthropic` and `ollama` branches are unchanged.
    - The unknown-value error becomes `LLM_PROVIDER must be "dahl", "anthropic" or "ollama", got "<v>"`.
  - **`dahlApiKey(env = process.env): string | undefined`:** trimmed, blank → `undefined`.
  - **`credentialSource()`:** extend `CredentialSource` with `"env:DAHL_API_KEY" | "dahl:missing-key"`, returned for the dahl provider.
  - **`logConfig()`:** for dahl log `provider`, `baseURL`, the credential label; hide `effort` / `fallbacks` like the ollama branch. Never log the key.
  - **Header comment:** update it (Dahl by default, Claude with `LLM_PROVIDER=anthropic`, or a local Ollama).
  - **LOGGING** (scope `config`):
    - `info("resolved", {..., provider, baseURL?, credentials})` as now;
    - `debug("llm provider", { provider, model, source: "LLM_PROVIDER" | "default" })`;
    - nothing that contains the key.
  - **Tests,** update `server/src/__tests__/config.test.ts` (node:test, explicit env objects, never mutate `process.env`):
    1. Empty env → `dahl`, `MiniMaxAI/MiniMax-M2.7`, the default base URL.
    2. `DAHL_MODEL` and `DAHL_BASE_URL=https://h/v1/` → model overridden, base URL without the trailing slash; `LLM_PROVIDER=Dahl` is case-insensitive.
    3. `LLM_PROVIDER=anthropic` → the former default-env expectations (`claude-opus-5-5`, effort `medium`, fallbacks `true`); `ANTHROPIC_FALLBACKS=off` → `false`.
    4. The existing ollama cases stay.
    5. `LLM_PROVIDER=gpt` → throws `/LLM_PROVIDER/` and the message lists all three providers.
    6. `dahlApiKey({})` and `{DAHL_API_KEY:"  "}` → `undefined`; `{DAHL_API_KEY:" k "}` → `"k"`.
  - Files: `server/src/config.ts`, `server/src/__tests__/config.test.ts`.

- [x] Task 2: Live API probe `server/scripts/probe-dahl.ts` + npm script `probe:dahl` (depends on 1). It verifies assumptions A1–A7 against the real service, **before** Tasks 3-4 are finalized.
  - **Needs `DAHL_API_KEY`.** Ask the user to put it in `.env`. Do not read or print `.env`; check presence only with `grep -c '^DAHL_API_KEY=.' .env`. If there is no key yet, Tasks 3-4 are still implemented against the OpenAI spec, and this task runs as part of Task 9; any deviation is then fixed there.
  - **Script behavior:**
    - Refuse to run unless `config.llm.provider === "dahl"`.
    - Use `fetch` directly, with `Authorization` only in the header. Print a compact JSON report to stdout and write the same to `bench/probe-dahl-<timestamp>.json` (`bench/` is git-ignored). Never print or write the key, and truncate raw chunks to 300 chars.
    - Probes:
      1. `GET /models` (no key): is `config.llm.model` listed?
      2. Streamed plain request (`max_tokens: 32000`, `stream_options: {include_usage: true}`, a short Russian prompt). Record time to first byte, chunk count, the keys seen in `choices[0].delta`, whether a final chunk carries `usage` (and its keys, including `prompt_tokens_details`), the `finish_reason`, the echoed `model`, and any `<think>` in `content`.
      3. Streamed tool request. Use the raw zod schemas of `create_bill` and `render_surface` from `buildTools(new Session("probe"))`, **not** inlined, as the worst case. Prompt: create the bill «Тест», people Аня and Боря, item «Чай» 100, paid by Аня. Record whether `tool_calls` arguments arrive in many chunks or one, whether `id` / `index` are on every chunk, the `finish_reason`, and whether the request is accepted at all (a 400 means the schema must be inlined, which the adapter does anyway).
      4. Error shapes: `Bearer invalid` → status + body; unknown model → the 400 body (where the message sits, whether live IDs are included).
  - **Assumptions to verify.** If an assumption is false, the adapter changes as listed:

    | # | Assumption | If false |
    |---|---|---|
    | A1 | the last chunk carries `usage` when `include_usage` is set | telemetry tokens stay 0; log at `debug`; drop `stream_options` if the server rejects it |
    | A2 | tool-call arguments stream in fragments | S10 degrades to the whole tree; document it |
    | A3 | reasoning arrives in `reasoning_content`, or as `<think>…</think>` inside `content` | the `ThinkFilter` covers the tag form; for reasoning as plain text without tags, add buffering (Task 9 finding) |
    | A4 | `finish_reason` is `tool_calls` when tools are called | covered by the `hasToolCalls` fallback in `mapFinishReason` |
    | A5 | `max_tokens: 32000` is accepted | lower it for dahl in `dahl.ts` |
    | A6 | zod JSON schemas are accepted (with or without inlining) | none, since inlining is mandatory |
    | A7 | error bodies are `{error:{message}}` or similar | `extractMessage` falls back to the raw text |

  - **LOGGING:** the script uses `console` like the other scripts. Findings go into the implementation summary.
  - **Status (2026-10-09):** the script is written and typechecks. No `DAHL_API_KEY` was available, so only the keyless probes ran: `/v1/models` lists the configured model, and **A7 is confirmed**: a 401 body is `{"error":{"code":"invalid_api_key","message":"invalid API token","type":"authentication_error"}}`. The chat probes (A1–A6) are deferred to Task 9 step 3.
  - Files: `server/scripts/probe-dahl.ts`, `server/package.json` (script `probe:dahl`).

<!-- Commit checkpoint: tasks 1-2 -->

### Phase 2: The Dahl adapter

- [x] Task 3: Pure wire conversions `server/src/agent/dahl-wire.ts` + `server/src/agent/__tests__/dahl-wire.test.ts` (depends on 1; informed by 2).
  - **`toOpenAiMessages(system, history): OpenAiMessage[]`:**
    - `system` (the text of the system blocks joined with `\n\n`) → a first `{role:"system", content}`.
    - User string content → `{role:"user"}`.
    - User blocks → first one `{role:"tool", tool_call_id, content}` per `tool_result` block (content = the string, or its text blocks joined), then **one** `{role:"user"}` with the remaining text blocks joined by `\n\n`. A `tool` message must directly follow the assistant message that issued the call.
    - An `image` block → throw `UnsupportedContentError("image")`.
    - Assistant blocks → `content` = the text blocks concatenated (`null` when empty and there are tool calls); each `tool_use` → `tool_calls[{id, type:"function", function:{name, arguments: JSON.stringify(input)}}]`; `thinking` / `redacted_thinking` are dropped.
  - **`toOpenAiTools(tools)`:**
    - → `{type:"function", function:{name, description, parameters}}`.
    - `parameters` = `input_schema` without `$schema`, with every local `$ref` (`#/$defs/…`) inlined and `$defs` removed. Guard against cycles by leaving `{}` for a recursive ref.
    - `eager_input_streaming` / `type:"custom"` are not forwarded.
  - **`parseSse(body: ReadableStream<Uint8Array>): AsyncGenerator<string>`:**
    - yields the joined `data:` payload of each event;
    - handles `\n` and `\r\n`, events split across network chunks at any byte, UTF-8 sequences split across chunks (use a streaming `TextDecoder`), `:` comment/keep-alive lines, and multi-line `data:`;
    - stops at `[DONE]`.
  - **`ThinkFilter`** with `push(text): string` (the visible part) and `end(): string`:
    - strips `<think>…</think>` spans, including tags split across chunks;
    - drops an unterminated span at the end of the stream;
    - only handles paired tags (see A3).
  - **`mapFinishReason(reason, hasToolCalls)`** and **`usageFromOpenAi(usage)`** as in the Design Summary.
  - **`parseToolArguments(raw, stopReason)`:**
    - `""` → `{}`;
    - invalid JSON on `max_tokens` → `{}` (so the runner raises `TruncatedToolInput`, not a retry);
    - invalid JSON otherwise → throw `new Anthropic.AnthropicError("Unable to parse tool parameter JSON from model. Please retry your request or adjust your prompt. Error: …")`. This matches `isToolJsonError` in `runner.ts`, so the existing re-issue path (2 retries) applies.
  - **`extractErrorMessage(bodyText)`:** the first of `error.message`, `message`, `detail`, `error` (string); else the trimmed raw text cut to 300 chars.
  - **LOGGING** (scope `agent.dahl.wire`): `debug` only. `inlineRefs` logs the number of refs inlined, and a dropped `thinking` block is logged once per conversion with a count. Nothing contains message text beyond lengths.
  - **Tests** (`node:test`):
    1. `toOpenAiMessages`:
       - a history `[user text, assistant text+2 tool_use, user 2 tool_result, assistant text]` yields exactly one `tool` message per call, in call order, right after the assistant message;
       - the state-sync block and the user text are joined into one message;
       - an image block throws `UnsupportedContentError`;
       - an assistant message with only tool calls has `content: null`.
    2. `toOpenAiTools(buildTools(controlSession().session))`: no `$ref`, `$defs` or `$schema` remain in any tool's `parameters`; `render_surface` keeps `surfaceId`, `components`, `data`; `create_bill` keeps the nested `split` shapes.
    3. `parseSse`: events split mid-line and mid-UTF-8 (a Cyrillic character cut in half), `\r\n`, a comment line, a `[DONE]` stop, multi-line data.
    4. `ThinkFilter`: `a<think>x</think>b` split at every position gives `ab`; an unterminated span is dropped; text without tags passes through unchanged.
    5. `mapFinishReason` table, `usageFromOpenAi` with and without `prompt_tokens_details`, `parseToolArguments` (empty / valid / invalid on `length` / invalid on `tool_calls`), `extractErrorMessage` for each body shape.
  - Files: `server/src/agent/dahl-wire.ts`, `server/src/agent/__tests__/dahl-wire.test.ts`.

- [x] Task 4: Client + tool runner `server/src/agent/dahl.ts` + `server/src/agent/__tests__/dahl.test.ts` (depends on 3).
  - **Exports:**
    - `createDahlClient(llm, opts?): Pick<Anthropic, "beta">`, where `opts = { apiKey?: string; fetchImpl?: typeof fetch; backoffMs?: number[]; idleTimeoutMs?: number; maxIterations?: number }`.
    - Defaults: `apiKey = dahlApiKey()`, `fetchImpl = fetch`, `backoffMs = [500, 1500]`, `idleTimeoutMs = 120_000`, `maxIterations = 16`.
    - Error classes: `DahlApiError {status, body}`, `DahlConnectionError`, `DahlMissingKeyError`, and re-export `UnsupportedContentError`.
    - The `as unknown as Pick<Anthropic,"beta">` cast lives in exactly one place, with a comment pointing at the e2e test.
  - **`toolRunner(params)`** returns an object with:
    - `get params()` → `{...params, messages: state.messages}`, where `state.messages` is the live Anthropic-shaped history (a copy of `params.messages`);
    - `[Symbol.asyncIterator]()`, an async generator doing one model request per iteration.
  - **Per iteration:**
    1. Yield a stream object. It has `[Symbol.asyncIterator]` (the Anthropic-style events) and `finalMessage()` (it drains the stream itself if called early, and caches its result).
    2. When the final message is complete, push `{role:"assistant", content}` to `state.messages` immediately, so history is right even if the consumer `break`s (refusal).
    3. If `stop_reason !== "tool_use"` or there are no tool_use blocks → return.
    4. Otherwise run every tool_use with `Promise.all(runRunnableTool(tool, input, {toolUse, toolUseBlock: toolUse, signal}))` (SDK helper, from `@anthropic-ai/sdk/lib/tools/BetaRunnableTool`).
    5. A tool name not in `params.tools` → an error result `Error: Tool '<name>' not found` (SDK parity).
    6. Push `{role:"user", content: [{type:"tool_result", tool_use_id, content, is_error?}]}`, in call order.
    7. After `maxIterations` requests, throw `Error("tool loop exceeded N iterations")`.
  - **Request:**
    - `POST {baseURL}/chat/completions`, headers `Authorization: Bearer <key>`, `Content-Type: application/json`, `Accept: text/event-stream`.
    - Body as in the Design Summary; `tools` omitted when empty.
    - No key → throw `DahlMissingKeyError` **before** `fetch`.
  - **Events, per chunk:**
    - Parse the chunk JSON; a chunk with an `error` field throws `DahlApiError`.
    - Text: through `ThinkFilter`, opening a text block on the first visible text (`content_block_start` → `text_delta` → `content_block_stop` when a tool block opens or the stream ends).
    - Tool calls: keyed by OpenAI `index`; a new `id` on a known index closes that block and starts a new one; a missing id → `call_<n>`; `name` arrives on the first chunk; `function.arguments` fragments → `input_json_delta`.
    - Block indexes are sequential per message (the `RenderStreamer` keys on them).
    - `finish_reason` and `usage` are kept; usage may arrive in a trailing chunk with an empty `choices`.
  - **Stream end:**
    - On `[DONE]` or body end, close open blocks and build the final message `{id, type:"message", role:"assistant", model: params.model, content, stop_reason, stop_details: null, usage}`. Tool inputs go through `parseToolArguments`.
    - A body that ends with neither `[DONE]` nor a `finish_reason` → throw `DahlConnectionError("stream ended unexpectedly")`.
  - **Errors and retries:**
    - A non-2xx response: read at most 2000 chars of body → `DahlApiError(status, extractErrorMessage(body), body)`.
    - Retry (up to `backoffMs.length`) on 502/503/504, network errors and idle timeouts that happen **before the first byte**. Never retry after streaming has started.
    - An idle `AbortController` is reset on every received chunk. On expiry → `DahlConnectionError("no data for <n> s")`.
    - Errors never include the request headers or key.
  - **LOGGING** (scope `agent.dahl`):
    - `info("request", { model, messages, tools, attempt })`;
    - `warn("retry", { status | err, attempt, delayMs })`;
    - `debug("first byte", { ttfbMs })`;
    - `debug("stream done", { ms, chunks, textChars, toolCalls, reasoningChunks, finishReason, usage })`;
    - `debug("tool results", { n, errors })`;
    - `error` only via the runner. Request bodies are never logged, only their size.
  - **Tests** (`dahl.test.ts`, stubbed `fetch` returning a `Response` over a `ReadableStream` of SSE strings; `backoffMs: [0, 0]`):
    1. A text turn: event order (`content_block_start`, `text_delta`…, `content_block_stop`), the final message and usage; assert the request URL, `Authorization`, `stream_options`, `max_tokens`, the leading system message, and no `tool_choice`.
    2. A tool loop with 2 requests: the second body carries the assistant `tool_calls` and the `tool` message; the history is `[user, assistant(tool_use), user(tool_result), assistant(text)]`; 2 parallel tool calls give 2 results in call order.
    3. Tool-call framing: arguments split over chunks; `index`-keyed interleaving; a missing id synthesized; a reused index with a new id starts a new block; text before a tool call closes the text block first.
    4. A `ToolError` → `is_error: true` with its content; an unknown tool → the not-found error result.
    5. `<think>` stripped across chunk boundaries; `reasoning_content` ignored; neither is in history.
    6. `length` with truncated tool JSON → `stop_reason: "max_tokens"`, `input: {}`, no throw; invalid JSON on `tool_calls` → `AnthropicError /tool parameter JSON/`.
    7. Errors: 401 / 402 / 400 → `DahlApiError` with status and message; 503 then 200 → one retry and success; 503 three times → thrown after 3 attempts; a rejected `fetch` → `DahlConnectionError`, retried; no key → `DahlMissingKeyError` and `fetch` never called; no thrown message or log contains the key.
    8. Truncated stream (no finish, no `[DONE]`) → `DahlConnectionError`; a chunk with `error` → `DahlApiError`; an idle timeout (a body that never yields, `idleTimeoutMs: 20`) → `DahlConnectionError`; `maxIterations: 1` with a tool call → throws.
    9. **End to end through `runTurn`** (`controlSession()`, `createDahlClient` + stub `fetch`, explicit `llm` of dahl):
       - a `get_summary` call then a text answer: `session.messages` is Anthropic-shaped, `telemetry.iterations === 2`, tokens are summed, a chat `delta` is emitted, `busy` is `false`;
       - a `render_surface` call whose arguments arrive in 3 chunks, the second one gated on a promise: the `createSurface` envelope is observed on the session **before** the gate is released (S10 path), then the final `updateDataModel`;
       - `content_filter` → the refusal text is sent and history keeps the assistant message.
  - Files: `server/src/agent/dahl.ts`, `server/src/agent/__tests__/dahl.test.ts`.

<!-- Commit checkpoint: tasks 3-4 -->

### Phase 3: Wiring

- [x] Task 5: Provider seam in `server/src/agent/llm.ts` (depends on 4).
  - **Clients:**
    - `createLlmClient(llm)` stays Anthropic-only and its parameter narrows to the anthropic/ollama variants (the scripts use it for `messages.countTokens`).
    - New `createAgentClient(llm): Pick<Anthropic,"beta">` → `createLlmClient(llm)` for anthropic/ollama, `createDahlClient(llm)` for dahl.
    - `getLlmClient()` memoizes `createAgentClient(config.llm)` and logs `info("client", { provider, baseURL? })` (baseURL for ollama and dahl).
  - **`providerParams(llm, system)`:** dahl → `{ system: [{ type: "text", text: system }] }` (merge with the ollama branch; the adapter flattens it). The anthropic branch stays byte-identical.
  - **`supportsVision(llm): boolean`** → `llm.provider !== "dahl"`.
  - **`describeLlmError`.** For dahl, check before the generic branches; the Anthropic branches stay byte-identical:
    - `DahlMissingKeyError` → «Не задан DAHL_API_KEY. Добавьте ключ в .env и перезапустите сервер.»
    - 401 → «Dahl не принял ключ (401). Проверьте DAHL_API_KEY и перезапустите сервер.»
    - 402 → «У ключа Dahl закончились токены (402). Пополните баланс или выделите токены из пула.»
    - 429 → «Слишком много запросов к Dahl, попробуйте через минуту.»
    - 400 matching `/not currently offered/i` → «Модель <m> сейчас не доступна в Dahl. <message tail with the live IDs> Задайте DAHL_MODEL.»
    - other 400 → «Некорректный запрос к Dahl: <message>»
    - 5xx → «Dahl временно недоступен (<status>), повторите через пару секунд.»
    - other statuses → «Ошибка Dahl <status>: <message>»
    - `DahlConnectionError` → «Нет соединения с Dahl (<baseURL>): <reason>. Проверьте сеть и повторите.»
    - `UnsupportedContentError` → «Модель <m> в Dahl не читает изображения — опишите чек текстом.»
    - `TruncatedToolInput` and everything else fall through to the existing generic text.
  - **`preflightDahl(llm, { apiKey = dahlApiKey(), fetchImpl = fetch } = {})`.** Never throws; returns `{ reachable, modelListed, keyPresent, keyAccepted: boolean | null, models: string[], warnings: string[] }`:
    1. No key → warning «DAHL_API_KEY не задан — чат будет отвечать ошибкой, пока ключ не добавлен в .env».
    2. `GET {baseURL}/models` (no key, 3 s timeout) → collect the ids. If the model is not among them → «модель <m> нет в /v1/models; сейчас доступны: …». Unreachable → «Dahl недоступен по <baseURL>: …».
    3. With a key: `GET <service root>/tokens/current` (3 s; the root is `new URL("/", baseURL)`) → 401 → «Dahl не принял DAHL_API_KEY (401)»; 200 → `keyAccepted: true`. The body is never logged.
    4. Always an `info` hint: «Dahl не читает изображения: загрузка фото чека (S9) отключена».
  - **LOGGING** (scope `agent.llm`):
    - `info("dahl ready", { model, models })` or one `warn("dahl preflight", { warning })` per warning;
    - `debug("preflight raw", { url path, status })`;
    - `debug("request params", { provider, keys })` as now;
    - never the key, never the token balance body.
  - **Tests,** extend `server/src/agent/__tests__/llm.test.ts`:
    1. `providerParams` for dahl: system block without `cache_control`, no `output_config` / `betas` / `fallbacks`; the anthropic cases still match today's shape.
    2. `describeLlmError` for each dahl case above; the anthropic `AuthenticationError` text unchanged; the model-not-offered text contains every live ID from the message.
    3. `preflightDahl` with a stub `fetchImpl`: no key → a warning and no `/tokens/current` request; the model missing from the list → a warning with the live IDs; `/models` rejects → unreachable; 401 on `/tokens/current` → `keyAccepted: false` + a warning; a clean run → no warnings.
    4. `supportsVision`: dahl `false`, anthropic and ollama `true`.
  - Files: `server/src/agent/llm.ts`, `server/src/agent/__tests__/llm.test.ts`.

- [x] Task 6: Runner, health, upload guard and startup (depends on 5).
  - **`server/src/agent/runner.ts`:**
    - Update the header comment (Dahl, Claude or Ollama behind one tool-runner surface).
    - Make the error log's `status` provider-neutral: `(err as { status?: number }).status` instead of `err instanceof Anthropic.APIError ? err.status : undefined`.
    - Nothing else changes: retries, the refusal branch, history rollback, the `message.model !== llm.model` check (the adapter always reports the requested model).
  - **`server/src/http/server.ts`:**
    - `createApp(opts: { llm?: LlmConfig } = {})`, defaulting to `config.llm`, so tests do not depend on the developer's `.env`.
    - `/api/health` → `{ ok: true, provider, model, vision: supportsVision(llm) }`.
    - `POST /api/upload`: first `if (!supportsVision(llm)) throw new HttpError(422, "NO_VISION", "Модель <model> (Dahl) не читает изображения. Опишите чек текстом или переключитесь на провайдера с vision (LLM_PROVIDER=anthropic).")`, before parsing the image into a turn and before touching the session.
    - In the `isMain` block, after `logConfig()`: `if (config.llm.provider === "dahl") void preflightDahl(config.llm)`. It is not awaited before `listen`.
    - Web client: no change, because `Chat.tsx` shows `json.error.message` for a failed upload.
  - **LOGGING:**
    - `http.server` logs `warn("upload refused: no vision", { provider })`;
    - `agent.turn` `start` already carries `provider`.
  - **Tests:**
    - Extend `server/src/agent/__tests__/runner.test.ts`:
      1. A dahl `llm` with the existing `stubClient()`: no `cache_control`, no `output_config` / `betas` / `fallbacks`; `telemetry.model` is the dahl model.
      2. An iterator that throws `new DahlApiError(401, …)` → an `error` event mentioning `DAHL_API_KEY`, the history rolled back, `busy === false`.
      3. An iterator that throws `DahlMissingKeyError` → the missing-key text.
    - New `server/src/http/__tests__/server.test.ts` (`createApp({ llm })` on `listen(0)`, closed in `after`): `/api/health` has `provider` and `vision`; `/api/upload` with a dahl `llm` → `422` with code `NO_VISION`, and the session has no messages and is not busy; with an anthropic `llm` the same request is accepted (`202`) when the turn is stubbed out or the session is already busy (`409`), whichever the existing structure allows without a model call.
  - Run `npm -w server test` and `npm -w server run typecheck`.
  - Files: `server/src/agent/runner.ts`, `server/src/http/server.ts`, `server/src/agent/__tests__/runner.test.ts`, `server/src/http/__tests__/server.test.ts`.

<!-- Commit checkpoint: tasks 5-6 -->

### Phase 4: Scripts, docs, verification

- [x] Task 7: Make the live-model scripts Dahl-aware (depends on 6).
  - **`server/scripts/count-prompt-tokens.ts`:**
    - Anthropic keeps `messages.countTokens` and ollama keeps the `max_tokens: 1` probe; both use `createLlmClient(config.llm)`, narrowed.
    - Dahl: `POST {baseURL}/chat/completions` with `{ model, max_tokens: 1, stream: false, messages: [system, user "Привет"] }` via `fetch`, and report `usage.prompt_tokens`. Method label `"usage(max_tokens=1)"`.
    - With no key, exit 1 with «DAHL_API_KEY не задан».
    - Update the header comment and the printed JSON (`provider` is already there).
  - **`server/scripts/smoke-s1.ts` and `server/scripts/bench-s1.ts`:**
    - Header comments only: they run on the active provider, the default is now Dahl, and S1 may take longer on a hosted model.
    - `bench-s1.ts` already writes `effort` for anthropic only. Keep it, and check that `cacheRead` is just `0` when the server sends no cached-token count.
  - Run `npm -w server run typecheck` (covers `tsconfig.scripts.json`).
  - **LOGGING:** the scripts print with `console` as today; nothing new beyond the provider and model lines.
  - Files: `server/scripts/count-prompt-tokens.ts`, `server/scripts/smoke-s1.ts`, `server/scripts/bench-s1.ts`.

- [x] Task 8: Documentation (depends on 6, 7). Mandatory docs checkpoint (`Docs: yes`). Write in Russian, matching the existing README.
  - **`README.md`:**
    - **Fix every statement the new default makes stale.** Find them with `grep -n "Claude\|по умолчанию\|ant auth\|ANTHROPIC\|LLM_PROVIDER" README.md`. Known spots:
      - line 3 «агент (Claude)» → «агент (LLM)»;
      - line 5 the «Модель» bullet: default `MiniMaxAI/MiniMax-M2.7` through Dahl; alternatives `LLM_PROVIDER=anthropic` and `ollama`;
      - line 6 the stack bullet: `@anthropic-ai/sdk` is still the tool-runner/tool helpers and the Claude/Ollama client, while Dahl is reached over plain `fetch`;
      - line 11 the requirement paragraph: Node ≥ 22 and a Dahl API key (`DAHL_API_KEY` in `.env`); Claude and Ollama as alternatives;
      - line 25 «По умолчанию по-прежнему Claude» (Ollama section);
      - line 66 «Вернуться на Claude: удалить `LLM_PROVIDER`» → removing it now returns Dahl, and Claude needs `LLM_PROVIDER=anthropic`;
      - the env table and line 175.
    - **New section «Модель через Dahl API (по умолчанию)»** before the «Локальная модель через Ollama» section, covering:
      1. What it is: the OpenAI-compatible `https://inference.dahl.global/v1`; how the server adapts it to the same tool runner (2 sentences).
      2. Setup: get a key from Dahl, then in `.env` set `DAHL_API_KEY=…` (optional `DAHL_MODEL`, `DAHL_BASE_URL`). List the live models with `curl https://inference.dahl.global/v1/models`; the three seen on 2026-10-09 and that the default is MiniMax-M2.7.
      3. Check: the log lines `[config] resolved … provider: "dahl"` and `[agent.llm] dahl ready`, or a `dahl preflight` warning with its fix; `curl localhost:8787/api/health` → `{"provider":"dahl","model":"…","vision":false}`; `npm -w server run probe:dahl` and `smoke:s1`.
      4. Limitations: no vision (photo upload «Фото чека» answers with a message); no prompt cache, effort or refusal fallback; the tool input may arrive in one piece so S10 may show the tree at once (state what Task 9 measured); quality depends on the model; the numbers in REPORT.md were measured on Claude.
      5. Troubleshooting table: «Не задан DAHL_API_KEY», 401, 402 (tokens exhausted), 429, «сейчас не доступна в Dahl» (400, with the live IDs), «Dahl временно недоступен» (503), «Нет соединения с Dahl».
    - **Env table:** update the `LLM_PROVIDER` row (`dahl` default; `anthropic`; `ollama`); add `DAHL_API_KEY`, `DAHL_MODEL`, `DAHL_BASE_URL`; mark `ANTHROPIC_*` as used with `LLM_PROVIDER=anthropic`.
    - **Migration note:** the default changed from Claude to Dahl; a `.env` that relied on the old default needs `LLM_PROVIDER=anthropic`.
    - The «Тесты и замеры» note already says the scripts use the active provider; add `probe:dahl` there.
  - **`.env.example`:** restructure it:
    - `LLM_PROVIDER=dahl` + `DAHL_API_KEY=` + commented `DAHL_MODEL` / `DAHL_BASE_URL` first;
    - the Anthropic block under a comment «only with LLM_PROVIDER=anthropic» (keeping the note that an empty `ANTHROPIC_API_KEY` shadows the `ant` profile);
    - a commented Ollama block;
    - `LOG_LEVEL`, `PORT`, `A2UI_STREAM` unchanged.
  - **`docs/DEMO.md`:** line 5, the prerequisite («`ant auth status` shows an active profile…») → «`DAHL_API_KEY` is set in `.env`; `curl localhost:8787/api/health` shows `provider: dahl`». If the demo has a photo step, mark it as «только Claude/Ollama с vision».
  - **Do not edit** `REPORT.md`.
  - Finally re-run the grep above to confirm nothing still claims Claude is the default.
  - **LOGGING:** n/a (docs).
  - Files: `README.md`, `.env.example`, `docs/DEMO.md`.

- [ ] Task 9: End-to-end verification against the real service (depends on 2, 7, 8). A manual step with recorded results. It needs the user's `DAHL_API_KEY`; do not read or print `.env`.
  1. `npm test && npm run typecheck` at the repo root: everything green.
  2. Confirm the key is present with `grep -c '^DAHL_API_KEY=.' .env` (ask the user to add it if the count is 0). Do **not** change `.env` yourself.
  3. `npm -w server run probe:dahl` (if not run in Task 2). Record the A1–A7 verdicts in the implementation summary. Fix `dahl.ts` / `dahl-wire.ts` for any false assumption (the table in Task 2 says how), with a test per fix.
  4. `npm -w server run count:prompt` → `inputTokens` (it must be far below the model's 180K context).
  5. `npm -w server run smoke:s1`. Record PASS/FAIL per check, `totalMs`, `firstA2uiMs`, tokens, `validationRepairs` for S1 and S6. The real-artifact check is the TZ §6 control example: balances +385/+385/−405/−365 and, after S6, +465/+425/−365/−525. Money is computed by code, so a FAIL means the model did not call the tools correctly. If the tool calls were right, note it as a model-quality finding, not a code bug.
  6. `npm run dev` and the «Пример из ТЗ» chip in the browser: the bill surface renders, S2–S5 buttons work (no model round trip), a chat edit works (S6), «Новый счёт» still works. Note whether the tree rendered progressively (`firstA2uiMs` ≪ `totalMs`) or all at once, and put that sentence into the README limitations (Task 8).
  7. Negative checks:
     - remove the key and restart → startup `warn`, the chat shows «Не задан DAHL_API_KEY…», and a request log shows no outbound call;
     - `DAHL_MODEL=nope/none` → the chat shows the 400 text with the live model IDs;
     - upload a photo → `422` and the Russian text in chat, session untouched;
     - `LLM_PROVIDER=ollama` without `OLLAMA_MODEL` → fail fast with the `OLLAMA_MODEL` message;
     - `LLM_PROVIDER=anthropic` → `/api/health` shows `anthropic` (full Claude check only if Anthropic access exists);
     - unset `LLM_PROVIDER` → `provider: "dahl"`.
  8. Secrets: run the server at `LOG_LEVEL=debug` through one S1 turn and confirm the key string appears nowhere in the output (`grep -c "$KEY"` against a captured log, without echoing the key).
  - If S1 does not complete within a sensible time or hits the idle timeout, record it and adjust `idleTimeoutMs` / the README note rather than hiding it.
  - **LOGGING:** confirm that the `agent.dahl`, `agent.llm` and `config` lines from Tasks 1-6 appear at `LOG_LEVEL=debug`, and that they hold no secrets.
  - Files: none (results go in the implementation summary; README only if a finding requires it).
  - **Status (2026-10-09): PARTIAL, left unchecked on purpose. No `DAHL_API_KEY` in this environment.**
    - **Done, no key needed:**
      - Step 1: `npm test` 241 + 37 pass, `npm run typecheck` clean.
      - Step 7, negative checks: with no key, the server starts, `dahl preflight` warns, the chat turn fails with «Не задан DAHL_API_KEY…», and no request is made (no `agent.dahl request` log line).
      - Step 7, upload: `POST /api/upload` on Dahl → 422 `NO_VISION`.
      - Step 7, provider switch: `LLM_PROVIDER=gpt` and `LLM_PROVIDER=ollama` without `OLLAMA_MODEL` both fail fast with the documented messages; `LLM_PROVIDER=anthropic` → `/api/health` shows `anthropic`, `vision: true`; unset → `dahl`.
      - Against the **real** service with a bogus key: the preflight (`/v1/models` 200, `/tokens/current` 401) and a chat turn (`POST /v1/chat/completions` → 401 `invalid API token`) both give «Dahl не принял ключ (401)». The bogus key appears in neither the server log nor the SSE events.
    - **Still to do with a real key (run in this order):** step 3 (`probe:dahl`, which settles A1–A6), step 4 (`count:prompt`), step 5 (`smoke:s1`), step 6 (browser S1 and the progressive-render note for the README), the unknown-model 400 in step 7, and the secrets grep of step 8 on a real S1 turn.

<!-- Commit checkpoint: tasks 7-9 -->
