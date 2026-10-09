// Pure conversions between the Anthropic-shaped agent (history, tools, usage, stop reasons) and
// the OpenAI chat-completions wire format that Dahl and Gemini speak. No network here; the client
// and tool loop live in ./openai-compat.ts.
import Anthropic from "@anthropic-ai/sdk";
import type { BetaMessageParam } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { createScope } from "../log.js";

const logger = createScope("agent.dahl.wire");

// --- OpenAI wire types (only the parts we send) ------------------------------------------

export interface OpenAiToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export type OpenAiUserPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };

export type OpenAiMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string | OpenAiUserPart[] }
  | { role: "assistant"; content: string | null; tool_calls?: OpenAiToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export interface OpenAiTool {
  type: "function";
  function: { name: string; description?: string; parameters: Record<string, unknown> };
}

/** The slice of an Anthropic tool definition we read (betaZodTool results carry more). */
export interface ToolDef {
  name: string;
  description?: string;
  input_schema?: unknown;
}

export type StopReason = "end_turn" | "tool_use" | "max_tokens" | "refusal";

/** The history holds something the provider cannot take (an image, when images are not allowed). */
export class UnsupportedContentError extends Error {
  constructor(readonly kind: string) {
    super(`chat completions cannot take "${kind}" content`);
  }
}

export interface ToOpenAiOptions {
  /** Send image blocks as `image_url` parts (vision models); otherwise they throw. Default false. */
  allowImages?: boolean;
}

type Block = { type: string; [key: string]: unknown };

// --- history → messages ------------------------------------------------------------------

/** Text of a `system` request param: a string or an array of text blocks. */
export function systemText(system: unknown): string | undefined {
  if (typeof system === "string") return system || undefined;
  if (!Array.isArray(system)) return undefined;
  const text = (system as Block[])
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("\n\n");
  return text || undefined;
}

function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return (content as Block[])
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("\n");
}

/** An Anthropic image source → the `image_url.url` OpenAI expects (a data: URL for base64). */
function imageUrl(source: unknown): string {
  const src = (source ?? {}) as { type?: unknown; media_type?: unknown; data?: unknown; url?: unknown };
  if (src.type === "base64" && typeof src.media_type === "string" && typeof src.data === "string") return `data:${src.media_type};base64,${src.data}`;
  if (src.type === "url" && typeof src.url === "string") return src.url;
  throw new UnsupportedContentError(`image source ${String(src.type)}`);
}

function pushUser(out: OpenAiMessage[], content: BetaMessageParam["content"], opts: ToOpenAiOptions): void {
  if (typeof content === "string") {
    out.push({ role: "user", content });
    return;
  }
  const parts: OpenAiUserPart[] = [];
  const results: OpenAiMessage[] = [];
  for (const block of content as Block[]) {
    if (block.type === "text") parts.push({ type: "text", text: String(block.text ?? "") });
    else if (block.type === "tool_result") {
      results.push({ role: "tool", tool_call_id: String(block.tool_use_id), content: toolResultText(block.content) });
    } else if (block.type === "image" && opts.allowImages) {
      parts.push({ type: "image_url", image_url: { url: imageUrl(block.source) } });
    } else throw new UnsupportedContentError(block.type);
  }
  // A `tool` message must directly follow the assistant message that issued the call.
  out.push(...results);
  if (parts.length === 0) return;
  // Text-only stays one plain string (what every server accepts); images need the parts array.
  const hasImage = parts.some((p) => p.type === "image_url");
  out.push({ role: "user", content: hasImage ? parts : parts.map((p) => (p.type === "text" ? p.text : "")).join("\n\n") });
}

/** Returns how many reasoning blocks were dropped. */
function pushAssistant(out: OpenAiMessage[], content: BetaMessageParam["content"]): number {
  if (typeof content === "string") {
    out.push({ role: "assistant", content });
    return 0;
  }
  let text = "";
  let dropped = 0;
  const toolCalls: OpenAiToolCall[] = [];
  for (const block of content as Block[]) {
    if (block.type === "text") text += String(block.text ?? "");
    else if (block.type === "tool_use") {
      toolCalls.push({ id: String(block.id), type: "function", function: { name: String(block.name), arguments: JSON.stringify(block.input ?? {}) } });
    } else if (block.type === "thinking" || block.type === "redacted_thinking") dropped++;
    else throw new UnsupportedContentError(block.type);
  }
  // An empty assistant turn (a refusal with no text) is left out: servers reject empty messages.
  if (toolCalls.length > 0) out.push({ role: "assistant", content: text || null, tool_calls: toolCalls });
  else if (text) out.push({ role: "assistant", content: text });
  return dropped;
}

/** Anthropic-shaped system prompt + history → OpenAI `messages`. Throws UnsupportedContentError on images unless allowed. */
export function toOpenAiMessages(system: string | undefined, history: BetaMessageParam[], opts: ToOpenAiOptions = {}): OpenAiMessage[] {
  const out: OpenAiMessage[] = [];
  if (system) out.push({ role: "system", content: system });
  let dropped = 0;
  for (const message of history) {
    if (message.role === "user") pushUser(out, message.content, opts);
    else dropped += pushAssistant(out, message.content);
  }
  if (dropped > 0) logger.debug("dropped reasoning blocks from history", { dropped });
  return out;
}

// --- tools -------------------------------------------------------------------------------

function resolvePointer(root: unknown, ref: string): unknown {
  let node: unknown = root;
  for (const raw of ref.replace(/^#\/?/, "").split("/").filter(Boolean)) {
    const key = decodeURIComponent(raw).replace(/~1/g, "/").replace(/~0/g, "~");
    if (node === null || typeof node !== "object") return undefined;
    node = (node as Record<string, unknown>)[key];
  }
  return node;
}

/**
 * Inlines every local `$ref` (zod emits `#/$defs/__schemaN` for shared schemas), drops `$defs`
 * and `$schema`. A `$ref` with siblings (e.g. a description) keeps the siblings on top of the
 * target. A recursive ref is replaced by `{}`.
 */
export function inlineRefs(schema: unknown): Record<string, unknown> {
  let inlined = 0;
  const walk = (node: unknown, stack: string[]): unknown => {
    if (Array.isArray(node)) return node.map((item) => walk(item, stack));
    if (node === null || typeof node !== "object") return node;
    const { $ref, ...rest } = node as Record<string, unknown>;
    if (typeof $ref === "string" && $ref.startsWith("#")) {
      if (stack.includes($ref)) return {};
      const target = resolvePointer(schema, $ref);
      inlined++;
      const resolved = target === undefined ? {} : (walk(target, [...stack, $ref]) as Record<string, unknown>);
      return { ...resolved, ...(walk(rest, stack) as Record<string, unknown>) };
    }
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(rest)) {
      if (node === schema && (key === "$defs" || key === "definitions" || key === "$schema")) continue;
      out[key] = walk(value, stack);
    }
    if ($ref !== undefined) out.$ref = $ref; // a non-local ref: leave it alone
    return out;
  };
  const result = (walk(schema ?? { type: "object", properties: {} }, []) ?? {}) as Record<string, unknown>;
  if (inlined > 0) logger.debug("inlined refs", { count: inlined });
  return result;
}

/** Anthropic tool definitions → OpenAI function tools. */
export function toOpenAiTools(tools: ToolDef[]): OpenAiTool[] {
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      ...(tool.description ? { description: tool.description } : {}),
      parameters: inlineRefs(tool.input_schema),
    },
  }));
}

// --- SSE ---------------------------------------------------------------------------------

/**
 * Yields the `data:` payload of every SSE event until `[DONE]` (not yielded) or the end of the
 * body. Handles `\n` / `\r\n`, events and UTF-8 sequences split across network chunks, `:`
 * comment lines and multi-line data. `state.done` is set when `[DONE]` was seen.
 */
export async function* parseSse(body: AsyncIterable<Uint8Array>, state: { done: boolean } = { done: false }): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = "";
  let data: string[] = [];

  const line = (raw: string): string | undefined | "done" => {
    if (raw === "") {
      if (data.length === 0) return undefined;
      const payload = data.join("\n");
      data = [];
      return payload === "[DONE]" ? "done" : payload;
    }
    if (raw.startsWith(":")) return undefined;
    const colon = raw.indexOf(":");
    const field = colon === -1 ? raw : raw.slice(0, colon);
    if (field === "data") {
      const value = colon === -1 ? "" : raw.slice(colon + 1);
      data.push(value.startsWith(" ") ? value.slice(1) : value);
    }
    return undefined;
  };

  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const result = line(buffer.slice(0, nl).replace(/\r$/, ""));
      buffer = buffer.slice(nl + 1);
      if (result === "done") {
        state.done = true;
        return;
      }
      if (result !== undefined) yield result;
    }
  }
  buffer += decoder.decode();
  if (buffer !== "") {
    const result = line(buffer.replace(/\r$/, ""));
    if (result === "done") {
      state.done = true;
      return;
    }
    if (result !== undefined) yield result;
  }
  // A final event without its terminating blank line.
  const last = line("");
  if (last === "done") state.done = true;
  else if (last !== undefined) yield last;
}

// --- reasoning tags ----------------------------------------------------------------------

const THINK_OPEN = "<think>";
const THINK_CLOSE = "</think>";

/** Longest suffix of `text` that is a proper prefix of `tag` (a tag possibly cut by a chunk boundary). */
function partialTagSuffix(text: string, tag: string): string {
  for (let len = Math.min(tag.length - 1, text.length); len > 0; len--) {
    if (tag.startsWith(text.slice(text.length - len))) return text.slice(text.length - len);
  }
  return "";
}

/**
 * Streaming remover of `<think>…</think>` spans (some models put their reasoning inline).
 * Handles tags split across chunks, drops an unterminated span, and trims the whitespace that
 * follows a closing tag. Only paired tags are handled.
 */
export class ThinkFilter {
  private inThink = false;
  private pending = "";
  private trimLeading = false;

  /** Feeds a chunk, returns the visible part. */
  push(text: string): string {
    let input = this.pending + text;
    this.pending = "";
    let out = "";
    const emit = (visible: string) => {
      let v = visible;
      if (this.trimLeading) {
        v = v.replace(/^\s+/, "");
        if (v) this.trimLeading = false;
      }
      out += v;
    };
    while (input) {
      if (this.inThink) {
        const end = input.indexOf(THINK_CLOSE);
        if (end === -1) {
          this.pending = partialTagSuffix(input, THINK_CLOSE);
          return out;
        }
        input = input.slice(end + THINK_CLOSE.length);
        this.inThink = false;
        this.trimLeading = true;
      } else {
        const start = input.indexOf(THINK_OPEN);
        if (start === -1) {
          const keep = partialTagSuffix(input, THINK_OPEN);
          emit(input.slice(0, input.length - keep.length));
          this.pending = keep;
          return out;
        }
        emit(input.slice(0, start));
        input = input.slice(start + THINK_OPEN.length);
        this.inThink = true;
      }
    }
    return out;
  }

  /** End of stream: whatever was held back as a possible tag start is plain text after all. */
  end(): string {
    const rest = this.inThink ? "" : this.pending;
    this.pending = "";
    this.inThink = false;
    return rest;
  }
}

// --- results -----------------------------------------------------------------------------

/** OpenAI `finish_reason` → Anthropic `stop_reason`. */
export function mapFinishReason(reason: string | null | undefined, hasToolCalls: boolean): StopReason {
  if (reason === "tool_calls") return "tool_use";
  if (reason === "length") return "max_tokens";
  if (reason === "content_filter") return "refusal";
  // "stop", null and anything unknown: some servers say "stop" even when they emitted tool calls.
  return hasToolCalls ? "tool_use" : "end_turn";
}

export interface AnthropicUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
}

const count = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);

/**
 * OpenAI `usage` → Anthropic usage. `prompt_tokens` includes cached tokens, Anthropic's
 * `input_tokens` does not, so the cached part moves to `cache_read_input_tokens`.
 */
export function usageFromOpenAi(usage: unknown): AnthropicUsage {
  const u = (usage ?? {}) as { prompt_tokens?: unknown; completion_tokens?: unknown; prompt_tokens_details?: { cached_tokens?: unknown } | null };
  const cached = count(u.prompt_tokens_details?.cached_tokens);
  return {
    input_tokens: Math.max(0, count(u.prompt_tokens) - cached),
    output_tokens: count(u.completion_tokens),
    cache_read_input_tokens: cached,
    cache_creation_input_tokens: 0,
  };
}

/**
 * Tool-call arguments (a JSON string accumulated from deltas) → the `input` object. Invalid
 * JSON on a `max_tokens` stop gives `{}` so the runner reports the truncation; otherwise it
 * throws the bare AnthropicError that runner.ts's isToolJsonError recognises and re-issues.
 */
export function parseToolArguments(raw: string, stopReason: StopReason): unknown {
  if (raw.trim() === "") return {};
  try {
    return JSON.parse(raw);
  } catch (err) {
    if (stopReason === "max_tokens") return {};
    throw new Anthropic.AnthropicError(
      `Unable to parse tool parameter JSON from model. Please retry your request or adjust your prompt. Error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

const MESSAGE_LIMIT = 300;

/** Human-readable message of an error body: error.message, message, detail, a string error, or the raw text. */
export function extractErrorMessage(bodyText: string): string {
  const raw = bodyText.trim();
  try {
    const body = JSON.parse(raw) as { error?: unknown; message?: unknown; detail?: unknown };
    const error = body.error;
    const candidates = [
      error && typeof error === "object" ? (error as { message?: unknown }).message : undefined,
      body.message,
      body.detail,
      typeof error === "string" ? error : undefined,
    ];
    const found = candidates.find((c): c is string => typeof c === "string" && c.trim() !== "");
    if (found) return found.trim();
  } catch {
    // not JSON: fall through to the raw text
  }
  return raw.length > MESSAGE_LIMIT ? `${raw.slice(0, MESSAGE_LIMIT)}…` : raw;
}
