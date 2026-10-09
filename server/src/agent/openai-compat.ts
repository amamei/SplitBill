// An OpenAI-compatible chat-completions API (Dahl, Gemini, OpenRouter) behind the Anthropic tool-runner
// surface the agent already uses: `client.beta.messages.toolRunner(params)` is an async iterator
// of streams, each stream an iterator of Anthropic-style events with `finalMessage()`. History
// stays Anthropic-shaped (`BetaMessageParam[]`); ./dahl-wire.ts converts it per request.
// Transport is plain fetch + SSE. The tool loop reuses the SDK's runRunnableTool, so ToolError
// and failed-tool results behave exactly as with Claude. Providers (./dahl.ts, ./gemini.ts,
// ./openrouter.ts) only supply their key, error classes, whether images may be sent and any extra
// request headers.
import type Anthropic from "@anthropic-ai/sdk";
import { runRunnableTool, type BetaRunnableTool, type BetaToolRunContext } from "@anthropic-ai/sdk/lib/tools/BetaRunnableTool";
import type { BetaMessageParam } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { createScope, type ScopedLogger } from "../log.js";
import {
  extractErrorMessage,
  mapFinishReason,
  parseSse,
  parseToolArguments,
  systemText,
  ThinkFilter,
  toOpenAiMessages,
  toOpenAiTools,
  UnsupportedContentError,
  usageFromOpenAi,
  type AnthropicUsage,
  type StopReason,
  type ToolDef,
} from "./dahl-wire.js";

export { UnsupportedContentError };

/** Where to send requests: `${baseURL}/chat/completions`. */
export interface OpenAiCompatTarget {
  model: string;
  baseURL: string;
}

const RETRYABLE_STATUSES = new Set([502, 503, 504]);
const ERROR_BODY_LIMIT = 2000;

/** A non-2xx reply or an error chunk. Providers subclass it so error texts can tell them apart. */
export class ChatApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body: string = "",
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class ChatConnectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class ChatMissingKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export interface ProviderProfile {
  /** Log scope suffix and message-id prefix, e.g. "dahl". */
  label: string;
  /** The key from the environment (used unless OpenAiCompatOptions.apiKey is given). */
  apiKey: () => string | undefined;
  /** Send image blocks as `image_url` parts; otherwise they throw UnsupportedContentError. */
  allowImages: boolean;
  /** Extra request headers (e.g. attribution). Cannot override authorization, content-type or accept. */
  headers?: Record<string, string>;
  errors: {
    api: new (status: number, message: string, body?: string) => ChatApiError;
    connection: new (message: string) => ChatConnectionError;
    missingKey: new () => ChatMissingKeyError;
  };
}

export interface OpenAiCompatOptions {
  /** Default: the provider's key from the environment. An explicit `undefined` means "no key". */
  apiKey?: string;
  fetchImpl?: typeof fetch;
  /** Delays between retries before the response headers arrive (502/503/504, network errors, idle timeout). */
  backoffMs?: number[];
  /** No bytes (headers or body) for this long aborts the request. */
  idleTimeoutMs?: number;
  /** Model requests per tool-runner call (guards against a model that never stops calling tools). */
  maxIterations?: number;
}

// --- Anthropic-shaped events and messages ------------------------------------------------

type ContentStart = { type: "text"; text: "" } | { type: "tool_use"; id: string; name: string; input: Record<string, never> };

export type ChatStreamEvent =
  | { type: "content_block_start"; index: number; content_block: ContentStart }
  | { type: "content_block_delta"; index: number; delta: { type: "text_delta"; text: string } | { type: "input_json_delta"; partial_json: string } }
  | { type: "content_block_stop"; index: number };

type FinalBlock = { type: "text"; text: string } | { type: "tool_use"; id: string; name: string; input: unknown };

export interface ChatFinalMessage {
  id: string;
  type: "message";
  role: "assistant";
  model: string;
  content: FinalBlock[];
  stop_reason: StopReason;
  stop_details: null;
  usage: AnthropicUsage;
}

interface RunnerParams {
  model: string;
  max_tokens: number;
  system?: unknown;
  tools?: Array<ToolDef & Partial<Pick<BetaRunnableTool, "run" | "parse">>>;
  messages: BetaMessageParam[];
  [key: string]: unknown;
}

// --- chunk assembly ----------------------------------------------------------------------

interface ToolAcc {
  blockIndex: number;
  id: string;
  /** The id came from the server (a different server id on a reused index means a new call). */
  serverId: boolean;
  name: string;
  args: string;
  sentArgs: number;
  started: boolean;
  stopped: boolean;
}

interface ToolCallDelta {
  index?: number;
  id?: string;
  function?: { name?: string; arguments?: string };
}

interface Chunk {
  error?: unknown;
  usage?: unknown;
  choices?: Array<{
    finish_reason?: string | null;
    delta?: {
      content?: unknown;
      reasoning_content?: unknown;
      reasoning?: unknown;
      tool_calls?: ToolCallDelta[];
    };
  }>;
}

/** Turns OpenAI stream chunks into Anthropic-style events and accumulates the final message. */
class Assembler {
  constructor(private readonly profile: ProviderProfile) {}
  private nextIndex = 0;
  private callCounter = 0;
  private readonly think = new ThinkFilter();
  private readonly blocks: Array<{ kind: "text"; index: number; text: string; open: boolean } | { kind: "tool"; acc: ToolAcc }> = [];
  private readonly byServerIndex = new Map<number, ToolAcc>();
  private text?: { kind: "text"; index: number; text: string; open: boolean };
  finishReason?: string | null;
  usage?: unknown;
  chunks = 0;
  reasoningChunks = 0;
  textChars = 0;

  *ingest(chunk: Chunk): Generator<ChatStreamEvent> {
    this.chunks++;
    if (chunk.error) {
      const error = chunk.error as { code?: unknown };
      const body = JSON.stringify(chunk);
      throw new this.profile.errors.api(typeof error.code === "number" ? error.code : 500, extractErrorMessage(body), body.slice(0, ERROR_BODY_LIMIT));
    }
    if (chunk.usage) this.usage = chunk.usage;
    const choice = chunk.choices?.[0];
    if (!choice) return;
    if (choice.finish_reason) this.finishReason = choice.finish_reason;
    const delta = choice.delta ?? {};
    if (delta.reasoning_content || delta.reasoning) this.reasoningChunks++;
    if (typeof delta.content === "string" && delta.content) {
      const visible = this.think.push(delta.content);
      if (visible) yield* this.appendText(visible);
    }
    for (const call of delta.tool_calls ?? []) yield* this.appendToolCall(call);
  }

  /** End of stream: flushes held-back text, closes and starts whatever is still open. */
  *finish(): Generator<ChatStreamEvent> {
    const rest = this.think.end();
    if (rest) yield* this.appendText(rest);
    yield* this.closeText();
    for (const block of this.blocks) {
      if (block.kind !== "tool") continue;
      yield* this.startTool(block.acc, true);
      yield* this.stopTool(block.acc);
    }
  }

  build(model: string): ChatFinalMessage {
    const hasToolCalls = this.blocks.some((b) => b.kind === "tool");
    const stopReason = mapFinishReason(this.finishReason, hasToolCalls);
    const content: FinalBlock[] = this.blocks.flatMap<FinalBlock>((b) =>
      b.kind === "text"
        ? b.text
          ? [{ type: "text", text: b.text }]
          : []
        : [{ type: "tool_use", id: b.acc.id, name: b.acc.name, input: parseToolArguments(b.acc.args, stopReason) }],
    );
    return { id: `${this.profile.label}_${Date.now().toString(36)}`, type: "message", role: "assistant", model, content, stop_reason: stopReason, stop_details: null, usage: usageFromOpenAi(this.usage) };
  }

  get toolCallCount(): number {
    return this.blocks.filter((b) => b.kind === "tool").length;
  }

  private *appendText(visible: string): Generator<ChatStreamEvent> {
    if (!this.text) {
      this.text = { kind: "text", index: this.nextIndex++, text: "", open: true };
      this.blocks.push(this.text);
      yield { type: "content_block_start", index: this.text.index, content_block: { type: "text", text: "" } };
    }
    this.text.text += visible;
    this.textChars += visible.length;
    yield { type: "content_block_delta", index: this.text.index, delta: { type: "text_delta", text: visible } };
  }

  private *closeText(): Generator<ChatStreamEvent> {
    if (this.text?.open) {
      this.text.open = false;
      yield { type: "content_block_stop", index: this.text.index };
    }
    this.text = undefined;
  }

  private *appendToolCall(call: ToolCallDelta): Generator<ChatStreamEvent> {
    const key = call.index ?? 0;
    let acc = this.byServerIndex.get(key);
    if (acc && call.id && acc.serverId && acc.id !== call.id) {
      yield* this.stopTool(acc); // the server reused the index for a new call
      acc = undefined;
    }
    if (!acc) {
      yield* this.closeText();
      for (const block of this.blocks) if (block.kind === "tool") yield* this.stopTool(block.acc);
      acc = { blockIndex: this.nextIndex++, id: call.id ?? `call_${this.callCounter++}`, serverId: Boolean(call.id), name: "", args: "", sentArgs: 0, started: false, stopped: false };
      this.byServerIndex.set(key, acc);
      this.blocks.push({ kind: "tool", acc });
    }
    if (call.function?.name && !acc.name) acc.name = call.function.name;
    if (call.function?.arguments) acc.args += call.function.arguments;
    yield* this.startTool(acc, false);
  }

  /** content_block_start needs the tool name (the render streamer keys on it); until then arguments are buffered. */
  private *startTool(acc: ToolAcc, force: boolean): Generator<ChatStreamEvent> {
    if (!acc.started) {
      if (!acc.name && !force) return;
      acc.started = true;
      yield { type: "content_block_start", index: acc.blockIndex, content_block: { type: "tool_use", id: acc.id, name: acc.name, input: {} } };
    }
    if (acc.args.length > acc.sentArgs && !acc.stopped) {
      const partial = acc.args.slice(acc.sentArgs);
      acc.sentArgs = acc.args.length;
      yield { type: "content_block_delta", index: acc.blockIndex, delta: { type: "input_json_delta", partial_json: partial } };
    }
  }

  private *stopTool(acc: ToolAcc): Generator<ChatStreamEvent> {
    if (acc.stopped) return;
    yield* this.startTool(acc, true);
    acc.stopped = true;
    yield { type: "content_block_stop", index: acc.blockIndex };
  }
}

// --- transport ---------------------------------------------------------------------------

class IdleTimer {
  private timer?: NodeJS.Timeout;
  constructor(
    private readonly controller: AbortController,
    readonly ms: number,
  ) {}
  reset(): void {
    this.clear();
    this.timer = setTimeout(() => this.controller.abort(), this.ms);
    this.timer.unref?.();
  }
  clear(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
}

function describeCause(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const cause = err.cause instanceof Error ? err.cause.message : undefined;
  return cause && cause !== err.message ? `${err.message}: ${cause}` : err.message;
}

function toConnectionError(profile: ProviderProfile, err: unknown, idle: IdleTimer, aborted: boolean): Error {
  if (err instanceof ChatApiError || err instanceof ChatConnectionError) return err;
  if (aborted) return new profile.errors.connection(`no data for ${Math.round(idle.ms / 1000)} s`);
  return new profile.errors.connection(describeCause(err));
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

interface Resolved {
  profile: ProviderProfile;
  logger: ScopedLogger;
  fetchImpl: typeof fetch;
  apiKey: () => string | undefined;
  backoffMs: number[];
  idleTimeoutMs: number;
  maxIterations: number;
}

interface OpenResponse {
  body: AsyncIterable<Uint8Array>;
  idle: IdleTimer;
  controller: AbortController;
}

/** POST with retries until the response headers arrive; non-2xx → the provider's ChatApiError. */
async function openResponse(llm: OpenAiCompatTarget, cfg: Resolved, payload: string, meta: { model: string; messages: number; tools: number }): Promise<OpenResponse> {
  const { profile, logger } = cfg;
  const key = cfg.apiKey();
  if (!key) throw new profile.errors.missingKey();
  // Defence in depth: a server that echoed the key in an error body must not leak it into chat or logs.
  const scrub = (text: string) => (key.length >= 8 ? text.split(key).join("[redacted]") : text);

  for (let attempt = 0; ; attempt++) {
    const controller = new AbortController();
    const idle = new IdleTimer(controller, cfg.idleTimeoutMs);
    logger.info("request", { ...meta, bytes: payload.length, attempt, headers: Object.keys(profile.headers ?? {}) });
    try {
      idle.reset();
      const res = await cfg.fetchImpl(`${llm.baseURL}/chat/completions`, {
        method: "POST",
        headers: { ...profile.headers, authorization: `Bearer ${key}`, "content-type": "application/json", accept: "text/event-stream" },
        body: payload,
        signal: controller.signal,
      });
      if (!res.ok) {
        const text = scrub((await res.text().catch(() => "")).slice(0, ERROR_BODY_LIMIT));
        throw new profile.errors.api(res.status, extractErrorMessage(text), text);
      }
      if (!res.body) throw new profile.errors.connection("empty response body");
      idle.reset(); // a fresh window for the first body bytes
      return { body: res.body as unknown as AsyncIterable<Uint8Array>, idle, controller };
    } catch (err) {
      idle.clear();
      const failure = toConnectionError(profile, err, idle, controller.signal.aborted);
      const retryable = failure instanceof ChatConnectionError || (failure instanceof ChatApiError && RETRYABLE_STATUSES.has(failure.status));
      if (!retryable || attempt >= cfg.backoffMs.length) throw failure;
      const delayMs = cfg.backoffMs[attempt];
      logger.warn("retry", { status: failure instanceof ChatApiError ? failure.status : undefined, err: failure.message, attempt, delayMs });
      await sleep(delayMs);
    }
  }
}

// --- one model request = one stream ------------------------------------------------------

class ChatStream {
  private readonly events: AsyncGenerator<ChatStreamEvent>;
  private final?: ChatFinalMessage;
  private error?: unknown;

  constructor(
    private readonly llm: OpenAiCompatTarget,
    private readonly cfg: Resolved,
    private readonly params: RunnerParams,
    private readonly history: () => BetaMessageParam[],
    private readonly onFinal: (message: ChatFinalMessage) => void,
  ) {
    this.events = this.run();
  }

  [Symbol.asyncIterator](): AsyncGenerator<ChatStreamEvent> {
    return this.events;
  }

  /** Resolves once the stream is complete (draining it if the caller has not consumed the events). */
  async finalMessage(): Promise<ChatFinalMessage> {
    for await (const _event of this.events) void _event;
    if (this.error) throw this.error;
    return this.final!;
  }

  private async *run(): AsyncGenerator<ChatStreamEvent> {
    try {
      yield* this.stream();
    } catch (err) {
      this.error = err;
      throw err;
    }
  }

  private async *stream(): AsyncGenerator<ChatStreamEvent> {
    const { params, cfg } = this;
    const { logger, profile } = cfg;
    const messages = toOpenAiMessages(systemText(params.system), this.history(), { allowImages: profile.allowImages });
    const tools = toOpenAiTools(params.tools ?? []);
    const payload = JSON.stringify({
      model: params.model,
      messages,
      ...(tools.length > 0 ? { tools } : {}),
      max_tokens: params.max_tokens,
      stream: true,
      stream_options: { include_usage: true },
    });
    const started = performance.now();
    const { body, idle, controller } = await openResponse(this.llm, this.cfg, payload, { model: params.model, messages: messages.length, tools: tools.length });

    const assembler = new Assembler(profile);
    const sse = { done: false };
    let firstByteLogged = false;
    const guarded = async function* (): AsyncGenerator<Uint8Array> {
      try {
        for await (const chunk of body) {
          idle.reset();
          yield chunk;
        }
      } catch (err) {
        throw toConnectionError(profile, err, idle, controller.signal.aborted);
      } finally {
        idle.clear();
      }
    };

    for await (const data of parseSse(guarded(), sse)) {
      if (!firstByteLogged) {
        firstByteLogged = true;
        logger.debug("first byte", { ttfbMs: Math.round(performance.now() - started) });
      }
      let chunk: Chunk;
      try {
        chunk = JSON.parse(data) as Chunk;
      } catch {
        logger.warn("unparseable chunk skipped", { chars: data.length });
        continue;
      }
      yield* assembler.ingest(chunk);
    }
    if (assembler.finishReason === undefined && !sse.done) throw new profile.errors.connection("stream ended unexpectedly");

    yield* assembler.finish();
    const message = assembler.build(params.model); // always the requested model: runner.ts reads a mismatch as a fallback
    logger.debug("stream done", {
      ms: Math.round(performance.now() - started),
      chunks: assembler.chunks,
      textChars: assembler.textChars,
      toolCalls: assembler.toolCallCount,
      reasoningChunks: assembler.reasoningChunks,
      finishReason: assembler.finishReason,
      usage: message.usage,
    });
    this.final = message;
    this.onFinal(message);
  }
}

// --- client ------------------------------------------------------------------------------

export function createOpenAiCompatClient(llm: OpenAiCompatTarget, profile: ProviderProfile, opts: OpenAiCompatOptions = {}): Pick<Anthropic, "beta"> {
  const logger = createScope(`agent.${profile.label}`);
  const cfg: Resolved = {
    profile,
    logger,
    fetchImpl: opts.fetchImpl ?? fetch,
    apiKey: () => ("apiKey" in opts ? opts.apiKey?.trim() || undefined : profile.apiKey()),
    backoffMs: opts.backoffMs ?? [500, 1500],
    idleTimeoutMs: opts.idleTimeoutMs ?? 120_000,
    maxIterations: opts.maxIterations ?? 16,
  };

  function toolRunner(params: RunnerParams) {
    const state = { messages: [...params.messages] };
    const tools = new Map((params.tools ?? []).map((tool) => [tool.name, tool]));

    return {
      get params() {
        return { ...params, messages: state.messages };
      },
      async *[Symbol.asyncIterator](): AsyncGenerator<ChatStream> {
        for (let iteration = 1; iteration <= cfg.maxIterations; iteration++) {
          const stream = new ChatStream(
            llm,
            cfg,
            params,
            () => state.messages,
            // Right when the message completes, so history is right even if the consumer stops (refusal).
            (message) => state.messages.push({ role: "assistant", content: message.content as BetaMessageParam["content"] }),
          );
          yield stream;
          const message = await stream.finalMessage();
          const toolUses = message.content.filter((b): b is Extract<FinalBlock, { type: "tool_use" }> => b.type === "tool_use");
          if (message.stop_reason !== "tool_use" || toolUses.length === 0) return;

          const results = await Promise.all(
            toolUses.map(async (toolUse) => {
              const tool = tools.get(toolUse.name);
              if (!tool?.run) {
                return { type: "tool_result" as const, tool_use_id: toolUse.id, content: `Error: Tool '${toolUse.name}' not found`, is_error: true };
              }
              const context = { toolUse, toolUseBlock: toolUse } as unknown as BetaToolRunContext;
              const outcome = await runRunnableTool(tool as unknown as BetaRunnableTool, toolUse.input, context);
              return { type: "tool_result" as const, tool_use_id: toolUse.id, content: outcome.content, ...(outcome.isError ? { is_error: true } : {}) };
            }),
          );
          logger.debug("tool results", { iteration, n: results.length, errors: results.filter((r) => "is_error" in r).length });
          state.messages.push({ role: "user", content: results as BetaMessageParam["content"] });
        }
        throw new Error(`tool loop exceeded ${cfg.maxIterations} iterations`);
      },
    };
  }

  // The agent only calls client.beta.messages.toolRunner(params); the end-to-end runTurn tests in
  // __tests__/dahl.test.ts and __tests__/gemini.test.ts guard this surface against drifting from what runner.ts consumes.
  return { beta: { messages: { toolRunner } } } as unknown as Pick<Anthropic, "beta">;
}
