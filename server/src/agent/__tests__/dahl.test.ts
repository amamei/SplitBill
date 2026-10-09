import { describe, it } from "node:test";
import assert from "node:assert/strict";
import Anthropic from "@anthropic-ai/sdk";
import type { LlmConfig } from "../../config.js";
import { createDahlClient, DahlApiError, DahlConnectionError, DahlMissingKeyError, UnsupportedContentError, type DahlClientOptions } from "../dahl.js";
import { createOpenAiCompatClient } from "../openai-compat.js";
import { runTurn } from "../runner.js";
import { buildTools } from "../tools.js";
import { controlSession } from "./helpers.js";

const LLM = { provider: "dahl", model: "MiniMaxAI/MiniMax-M2.7", baseURL: "https://dahl.test/v1" } as const satisfies LlmConfig;
const KEY = "dahl-test-key-0123456789";
const enc = new TextEncoder();

// --- stubs -------------------------------------------------------------------------------

interface Recorded {
  url: string;
  init: RequestInit;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
}

type Handler = (rec: Recorded) => Response | Promise<Response>;

/** Scripted fetch: the n-th call uses the n-th handler (the last one repeats). */
function fakeFetch(...handlers: Handler[]) {
  const calls: Recorded[] = [];
  const impl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const rec: Recorded = { url: String(input), init: init ?? {}, body: init?.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(rec);
    return handlers[Math.min(calls.length - 1, handlers.length - 1)](rec);
  }) as typeof fetch;
  return { impl, calls };
}

const streamOf = (parts: string[]) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      for (const part of parts) controller.enqueue(enc.encode(part));
      controller.close();
    },
  });

const sse = (...events: unknown[]) => events.map((e) => `data: ${typeof e === "string" ? e : JSON.stringify(e)}\n\n`);
/** A 200 SSE response; every entry of `parts` arrives as its own network chunk. */
const ok = (parts: string[]): Handler => () => new Response(streamOf(parts), { status: 200, headers: { "content-type": "text/event-stream" } });
const failure = (status: number, body: unknown): Handler => () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status });

const text = (t: string) => ({ model: "served-by-other", choices: [{ index: 0, delta: { content: t }, finish_reason: null }] });
const finish = (reason: string) => ({ choices: [{ index: 0, delta: {}, finish_reason: reason }] });
const usage = (prompt: number, completion: number, cached?: number) => ({
  choices: [],
  usage: { prompt_tokens: prompt, completion_tokens: completion, ...(cached === undefined ? {} : { prompt_tokens_details: { cached_tokens: cached } }) },
});
const call = (index: number, f: { id?: string; name?: string; args?: string }) => ({
  choices: [{ index: 0, delta: { tool_calls: [{ index, ...(f.id ? { id: f.id, type: "function" } : {}), function: { ...(f.name ? { name: f.name } : {}), ...(f.args !== undefined ? { arguments: f.args } : {}) } }] }, finish_reason: null }],
});

const apiError = (status: number, message: string) => failure(status, { error: { code: "e", message, type: "t" } });

// --- driver ------------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

function client(impl: typeof fetch, extra: DahlClientOptions = {}) {
  return createDahlClient(LLM, { apiKey: KEY, fetchImpl: impl, backoffMs: [0, 0], ...extra });
}

function params(extra: Record<string, unknown> = {}) {
  return {
    model: LLM.model,
    max_tokens: 32000,
    system: [{ type: "text", text: "SYS" }],
    messages: [{ role: "user", content: [{ type: "text", text: "привет" }] }],
    stream: true,
    tools: [] as unknown[],
    ...extra,
  };
}

function runnerOf(c: Pick<Anthropic, "beta">, p: Record<string, unknown> = params()): Any {
  return (c.beta.messages as Any).toolRunner(p);
}

/** Runs the whole tool loop the way runner.ts does and returns events and final message per request. */
async function drain(runner: Any): Promise<Array<{ events: Any[]; final: Any }>> {
  const out: Array<{ events: Any[]; final: Any }> = [];
  for await (const stream of runner) {
    const events: Any[] = [];
    for await (const event of stream) events.push(event);
    out.push({ events, final: await stream.finalMessage() });
  }
  return out;
}

const eventTypes = (events: Any[]) => events.map((e) => `${e.type}${e.delta ? `:${e.delta.type}` : ""}@${e.index}`);

// --- provider profile -------------------------------------------------------------------

describe("createOpenAiCompatClient: profile headers", () => {
  it("sends the profile's extra headers but never lets them override auth or content type", async () => {
    const { impl, calls } = fakeFetch(ok(sse(text("ok"), finish("stop")).concat(["data: [DONE]\n\n"])));
    const c = createOpenAiCompatClient(
      LLM,
      {
        label: "test",
        apiKey: () => undefined,
        allowImages: false,
        headers: { "X-Title": "t", authorization: "evil", "content-type": "text/plain" },
        errors: { api: DahlApiError, connection: DahlConnectionError, missingKey: DahlMissingKeyError },
      },
      { apiKey: KEY, fetchImpl: impl, backoffMs: [0, 0] },
    );
    await drain(runnerOf(c));

    const headers = calls[0].init.headers as Record<string, string>;
    assert.equal(headers["X-Title"], "t");
    assert.equal(headers.authorization, `Bearer ${KEY}`);
    assert.equal(headers["content-type"], "application/json");
    assert.equal(headers.accept, "text/event-stream");
  });
});

// --- text turns --------------------------------------------------------------------------

describe("createDahlClient: a text turn", () => {
  it("streams Anthropic-style events and a final message, and sends the OpenAI request", async () => {
    const { impl, calls } = fakeFetch(ok(sse(text("При"), text("вет"), finish("stop"), usage(120, 4, 100)).concat(["data: [DONE]\n\n"])));
    const [turn] = await drain(runnerOf(client(impl)));

    assert.deepEqual(eventTypes(turn.events), ["content_block_start@0", "content_block_delta:text_delta@0", "content_block_delta:text_delta@0", "content_block_stop@0"]);
    assert.equal(turn.events[1].delta.text, "При");
    assert.deepEqual(turn.final.content, [{ type: "text", text: "Привет" }]);
    assert.equal(turn.final.stop_reason, "end_turn");
    assert.equal(turn.final.model, LLM.model, "always the requested model, never the one the server echoes");
    assert.deepEqual(turn.final.usage, { input_tokens: 20, output_tokens: 4, cache_read_input_tokens: 100, cache_creation_input_tokens: 0 });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://dahl.test/v1/chat/completions");
    assert.equal(calls[0].init.method, "POST");
    const headers = calls[0].init.headers as Record<string, string>;
    assert.equal(headers.authorization, `Bearer ${KEY}`);
    assert.equal(headers["content-type"], "application/json");
    const body = calls[0].body;
    assert.equal(body.model, LLM.model);
    assert.equal(body.max_tokens, 32000);
    assert.equal(body.stream, true);
    assert.deepEqual(body.stream_options, { include_usage: true });
    assert.deepEqual(body.messages, [
      { role: "system", content: "SYS" },
      { role: "user", content: "привет" },
    ]);
    assert.equal("tool_choice" in body, false);
    assert.equal("tools" in body, false, "no tools key when there are none");
  });

  it("finalMessage() drains the stream by itself when the events were not consumed", async () => {
    const { impl } = fakeFetch(ok(sse(text("ок"), finish("stop"))));
    const runner = runnerOf(client(impl));
    for await (const stream of runner) {
      const final = await stream.finalMessage();
      assert.deepEqual(final.content, [{ type: "text", text: "ок" }]);
    }
    assert.equal(runner.params.messages.at(-1).role, "assistant");
  });

  it("accepts a stream that ends without [DONE] as long as it had a finish_reason, and one with [DONE] only", async () => {
    await drain(runnerOf(client(fakeFetch(ok(sse(text("a"), finish("stop")))).impl)));
    const turns = await drain(runnerOf(client(fakeFetch(ok(sse(text("a")).concat(["data: [DONE]\n\n"]))).impl)));
    assert.equal(turns[0].final.stop_reason, "end_turn");
  });
});

// --- tool loop ---------------------------------------------------------------------------

describe("createDahlClient: the tool loop", () => {
  it("runs a tool, sends its result back, and keeps Anthropic-shaped history", async () => {
    const { session } = controlSession();
    const { impl, calls } = fakeFetch(
      ok(sse(call(0, { id: "call_1", name: "get_summary", args: "" }), call(0, { args: "{}" }), finish("tool_calls"), usage(10, 2))),
      ok(sse(text("Итог"), finish("stop"), usage(20, 3))),
    );
    const runner = runnerOf(client(impl), params({ tools: buildTools(session) }));
    const turns = await drain(runner);

    assert.equal(turns.length, 2);
    assert.deepEqual(eventTypes(turns[0].events), ["content_block_start@0", "content_block_delta:input_json_delta@0", "content_block_stop@0"]);
    assert.equal(turns[0].events[0].content_block.name, "get_summary");
    assert.equal(turns[0].final.stop_reason, "tool_use");

    const second = calls[1].body.messages;
    assert.deepEqual(second.at(-2), { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "get_summary", arguments: "{}" } }] });
    assert.equal(second.at(-1).role, "tool");
    assert.equal(second.at(-1).tool_call_id, "call_1");
    assert.equal(JSON.parse(second.at(-1).content).ok, true);
    assert.equal(calls[0].body.tools.length, 9, "all nine tools are offered");
    assert.equal(calls[0].body.tools.find((t: Any) => t.function.name === "create_bill").function.parameters.$defs, undefined);

    const history = runner.params.messages;
    assert.deepEqual(
      history.map((m: Any) => m.role),
      ["user", "assistant", "user", "assistant"],
    );
    assert.equal(history[1].content[0].type, "tool_use");
    assert.deepEqual(history[1].content[0].input, {});
    assert.equal(history[2].content[0].type, "tool_result");
    assert.equal(history[2].content[0].tool_use_id, "call_1");
    assert.equal(history[2].content[0].is_error, undefined);
    assert.deepEqual(history[3].content, [{ type: "text", text: "Итог" }]);
  });

  it("runs parallel tool calls and returns their results in call order", async () => {
    const { session } = controlSession();
    const before = session.store.getBill(session.billId!).people.length;
    const { impl, calls } = fakeFetch(
      ok(sse(call(0, { id: "a", name: "get_summary", args: "{}" }), call(1, { id: "b", name: "add_person", args: '{"name":"Дима"}' }), finish("tool_calls"))),
      ok(sse(text("Готово"), finish("stop"))),
    );
    await drain(runnerOf(client(impl), params({ tools: buildTools(session) })));
    const tools = calls[1].body.messages.filter((m: Any) => m.role === "tool");
    assert.deepEqual(
      tools.map((m: Any) => m.tool_call_id),
      ["a", "b"],
    );
    assert.equal(session.store.getBill(session.billId!).people.length, before + 1);
  });

  it("reports a ToolError, bad input and an unknown tool as error results", async () => {
    const { session } = controlSession();
    const { impl } = fakeFetch(
      ok(
        sse(
          call(0, { id: "e1", name: "remove_item", args: '{"item":"нет такой"}' }),
          call(1, { id: "e2", name: "add_person", args: "{}" }),
          call(2, { id: "e3", name: "nope", args: "{}" }),
          finish("tool_calls"),
        ),
      ),
      ok(sse(text("ок"), finish("stop"))),
    );
    const runner = runnerOf(client(impl), params({ tools: buildTools(session) }));
    await drain(runner);
    const results = runner.params.messages[2].content;
    assert.equal(results.length, 3);
    for (const r of results) assert.equal(r.is_error, true, r.tool_use_id);
    assert.match(results[0].content, /NOT_FOUND/);
    assert.match(results[1].content, /^Error:/);
    assert.equal(results[2].content, "Error: Tool 'nope' not found");
  });

  it("stops after maxIterations model requests", async () => {
    const { session } = controlSession();
    const { impl, calls } = fakeFetch(ok(sse(call(0, { id: "a", name: "get_summary", args: "{}" }), finish("tool_calls"))));
    await assert.rejects(drain(runnerOf(client(impl, { maxIterations: 2 }), params({ tools: buildTools(session) }))), /tool loop exceeded 2 iterations/);
    assert.equal(calls.length, 2);
  });
});

// --- tool-call framing -------------------------------------------------------------------

describe("createDahlClient: tool-call framing", () => {
  /** The first model request only: the stub answers every request alike, so the tool loop must not continue. */
  const first = async (...chunks: unknown[]) => {
    for await (const stream of runnerOf(client(fakeFetch(ok(sse(...chunks))).impl))) {
      const events: Any[] = [];
      for await (const event of stream) events.push(event);
      return { events, final: await stream.finalMessage() };
    }
    throw new Error("the runner yielded no stream");
  };

  it("closes the text block before a tool call opens", async () => {
    const turn = await first(text("Смотрю."), call(0, { id: "c", name: "get_summary", args: "{}" }), finish("tool_calls"));
    assert.deepEqual(eventTypes(turn.events), [
      "content_block_start@0",
      "content_block_delta:text_delta@0",
      "content_block_stop@0",
      "content_block_start@1",
      "content_block_delta:input_json_delta@1",
      "content_block_stop@1",
    ]);
    assert.deepEqual(
      turn.final.content.map((b: Any) => b.type),
      ["text", "tool_use"],
    );
  });

  it("assembles arguments split over chunks and interleaved calls keyed by index", async () => {
    const turn = await first(
      call(0, { id: "a", name: "add_person" }),
      call(1, { id: "b", name: "add_person" }),
      call(0, { args: '{"na' }),
      call(1, { args: '{"name":"Б' }),
      call(0, { args: 'me":"А"}' }),
      call(1, { args: 'ы"}' }),
      finish("tool_calls"),
    );
    const inputs = turn.final.content.map((b: Any) => b.input);
    assert.deepEqual(inputs, [{ name: "А" }, { name: "Бы" }]);
    for (const e of turn.events) if (e.type === "content_block_delta") assert.equal(typeof e.index, "number");
  });

  it("synthesizes a missing id", async () => {
    const turn = await first(call(0, { name: "get_summary", args: "{}" }), finish("tool_calls"));
    assert.match(turn.final.content[0].id, /^call_\d+$/);
  });

  it("starts a new block when the server reuses an index with a new id", async () => {
    const turn = await first(call(0, { id: "a", name: "get_summary", args: "{}" }), call(0, { id: "b", name: "add_person", args: '{"name":"X"}' }), finish("tool_calls"));
    assert.deepEqual(
      turn.final.content.map((b: Any) => [b.id, b.name]),
      [
        ["a", "get_summary"],
        ["b", "add_person"],
      ],
    );
  });

  it("holds arguments back until the tool name is known", async () => {
    const turn = await first(call(0, { id: "c" }), call(0, { args: '{"x":' }), call(0, { name: "get_summary" }), call(0, { args: "1}" }), finish("tool_calls"));
    assert.equal(turn.events[0].type, "content_block_start");
    assert.equal(turn.events[0].content_block.name, "get_summary");
    const partials = turn.events.filter((e: Any) => e.delta?.type === "input_json_delta").map((e: Any) => e.delta.partial_json);
    assert.deepEqual(partials, ['{"x":', "1}"]);
    assert.deepEqual(turn.final.content[0].input, { x: 1 });
  });

  it("maps finish reasons: length with cut-off arguments is max_tokens (no throw), content_filter is a refusal", async () => {
    const cut = await first(call(0, { id: "c", name: "render_surface", args: '{"components":[{"id":"ro' }), finish("length"));
    assert.equal(cut.final.stop_reason, "max_tokens");
    assert.deepEqual(cut.final.content[0].input, {});
    assert.equal((await first(finish("content_filter"))).final.stop_reason, "refusal");
  });

  it("throws the retryable parse error for invalid arguments on a normal stop", async () => {
    await assert.rejects(
      first(call(0, { id: "c", name: "get_summary", args: '{"a":' }), finish("tool_calls")),
      (err: unknown) => err instanceof Anthropic.AnthropicError && !(err instanceof Anthropic.APIError) && /tool parameter JSON/i.test(err.message),
    );
  });

  it("does not put a failed message into history, so the runner can re-issue the request", async () => {
    const runner = runnerOf(client(fakeFetch(ok(sse(call(0, { id: "c", name: "get_summary", args: "{" }), finish("tool_calls")))).impl));
    await assert.rejects(drain(runner));
    assert.equal(runner.params.messages.length, 1);
  });
});

// --- reasoning ---------------------------------------------------------------------------

describe("createDahlClient: reasoning", () => {
  it("strips <think> spans (split across chunks) and ignores reasoning_content, in events and in history", async () => {
    const { session } = controlSession();
    const { impl, calls } = fakeFetch(
      ok(
        sse(
          { choices: [{ delta: { reasoning_content: "думаю" }, finish_reason: null }] },
          text("<thi"),
          text("nk>секрет</th"),
          text("ink>\n\nСмотрю."),
          call(0, { id: "c", name: "get_summary", args: "{}" }),
          finish("tool_calls"),
        ),
      ),
      ok(sse(text("Готово"), finish("stop"))),
    );
    const runner = runnerOf(client(impl), params({ tools: buildTools(session) }));
    const turns = await drain(runner);
    const shown = turns[0].events.filter((e: Any) => e.delta?.type === "text_delta").map((e: Any) => e.delta.text).join("");
    assert.equal(shown, "Смотрю.");
    assert.equal(calls[1].body.messages.at(-2).content, "Смотрю.");
    assert.doesNotMatch(JSON.stringify(runner.params.messages), /секрет|думаю/);
  });
});

// --- errors, retries, timeouts -----------------------------------------------------------

describe("createDahlClient: errors", () => {
  it("raises DahlApiError with status and the server message, without retrying a 401", async () => {
    const { impl, calls } = fakeFetch(failure(401, { error: { code: "invalid_api_key", message: "invalid API token", type: "authentication_error" } }));
    await assert.rejects(drain(runnerOf(client(impl))), (err: unknown) => err instanceof DahlApiError && err.status === 401 && err.message === "invalid API token");
    assert.equal(calls.length, 1);
  });

  it("keeps 402 and the model-not-offered 400 (with the live ids) intact", async () => {
    await assert.rejects(drain(runnerOf(client(fakeFetch(apiError(402, "tokens exhausted")).impl))), (e: unknown) => e instanceof DahlApiError && e.status === 402);
    const message = "This model is not currently offered. Available: MiniMaxAI/MiniMax-M2.7, zai-org/GLM-5.3-Flash";
    await assert.rejects(drain(runnerOf(client(fakeFetch(apiError(400, message)).impl))), (e: unknown) => e instanceof DahlApiError && e.status === 400 && e.message === message);
  });

  it("retries a 503 and succeeds", async () => {
    const { impl, calls } = fakeFetch(apiError(503, "overloaded"), ok(sse(text("ок"), finish("stop"))));
    const turns = await drain(runnerOf(client(impl)));
    assert.equal(calls.length, 2);
    assert.equal(turns[0].final.content[0].text, "ок");
  });

  it("gives up on a persistent 503 after the configured retries", async () => {
    const { impl, calls } = fakeFetch(apiError(503, "overloaded"));
    await assert.rejects(drain(runnerOf(client(impl))), (e: unknown) => e instanceof DahlApiError && e.status === 503);
    assert.equal(calls.length, 3);
  });

  it("retries network errors and reports the cause", async () => {
    const refuse: Handler = () => {
      throw new TypeError("fetch failed", { cause: new Error("connect ECONNREFUSED") });
    };
    const { impl, calls } = fakeFetch(refuse, ok(sse(text("ок"), finish("stop"))));
    await drain(runnerOf(client(impl)));
    assert.equal(calls.length, 2);

    const always = fakeFetch(refuse);
    await assert.rejects(drain(runnerOf(client(always.impl))), (e: unknown) => e instanceof DahlConnectionError && /ECONNREFUSED/.test(e.message));
    assert.equal(always.calls.length, 3);
  });

  it("fails without a request when there is no key", async () => {
    const { impl, calls } = fakeFetch(ok(sse(finish("stop"))));
    await assert.rejects(drain(runnerOf(createDahlClient(LLM, { apiKey: undefined, fetchImpl: impl }))), DahlMissingKeyError);
    await assert.rejects(drain(runnerOf(createDahlClient(LLM, { apiKey: "  ", fetchImpl: impl }))), DahlMissingKeyError);
    assert.equal(calls.length, 0);
  });

  it("refuses an image in the history before any request", async () => {
    const { impl, calls } = fakeFetch(ok(sse(finish("stop"))));
    const messages = [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "AA==" } }] }];
    await assert.rejects(drain(runnerOf(client(impl), params({ messages }))), UnsupportedContentError);
    assert.equal(calls.length, 0);
  });

  it("never lets the key through: a server that echoes it is redacted, and it is only sent as the Bearer header", async () => {
    const { impl, calls } = fakeFetch(apiError(400, `bad request for key ${KEY}`));
    await assert.rejects(drain(runnerOf(client(impl))), (e: unknown) => {
      const err = e as DahlApiError;
      return err instanceof DahlApiError && !err.message.includes(KEY) && !err.body.includes(KEY) && err.message.includes("[redacted]");
    });
    assert.equal(JSON.stringify(calls[0].body).includes(KEY), false);
  });

  it("detects a truncated stream and surfaces an error chunk", async () => {
    await assert.rejects(drain(runnerOf(client(fakeFetch(ok(sse(text("обрыв")))).impl))), (e: unknown) => e instanceof DahlConnectionError && /ended unexpectedly/.test(e.message));
    await assert.rejects(drain(runnerOf(client(fakeFetch(ok(sse(text("а"), { error: { message: "boom", code: 500 } }))).impl))), (e: unknown) => e instanceof DahlApiError && e.status === 500 && e.message === "boom");
  });

  it("aborts after idleTimeoutMs without data, in the body and before the headers, and retries only the latter", async () => {
    const abortable = (signal: AbortSignal | null | undefined, reject: (e: unknown) => void) => signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));

    const stalledBody = fakeFetch((rec) => new Response(new ReadableStream({ start: (c) => abortable(rec.init.signal, (e) => c.error(e)) }), { status: 200 }));
    await assert.rejects(drain(runnerOf(client(stalledBody.impl, { idleTimeoutMs: 30 }))), (e: unknown) => e instanceof DahlConnectionError && /no data for/.test(e.message));
    assert.equal(stalledBody.calls.length, 1, "a stall after the headers is not retried");

    const stalledHeaders = fakeFetch((rec) => new Promise<Response>((_resolve, reject) => abortable(rec.init.signal, reject)) as unknown as Response);
    await assert.rejects(drain(runnerOf(client(stalledHeaders.impl, { idleTimeoutMs: 30, backoffMs: [0] }))), DahlConnectionError);
    assert.equal(stalledHeaders.calls.length, 2, "a stall before the headers is retried");
  });
});

// --- end to end through runTurn ----------------------------------------------------------

describe("runTurn through the Dahl adapter", () => {
  it("answers a get_summary round trip: history, iterations, summed tokens, chat deltas", async () => {
    const { session } = controlSession();
    const { impl } = fakeFetch(
      ok(sse(call(0, { id: "c1", name: "get_summary", args: "{}" }), finish("tool_calls"), usage(100, 10, 0))),
      ok(sse(text("Итог: "), text("готово."), finish("stop"), usage(150, 5, 100))),
    );
    const chat: Array<{ type: string; text?: string }> = [];
    session.subscribe((event, data) => event === "chat" && chat.push(data as { type: string; text?: string }));

    const telemetry = await runTurn(session, "покажи итог", { client: client(impl), llm: LLM });

    assert.equal(telemetry.error, undefined);
    assert.equal(telemetry.iterations, 2);
    assert.deepEqual(telemetry.tokens, { input: 150, output: 15, cacheRead: 100, cacheWrite: 0 });
    assert.equal(telemetry.model, LLM.model);
    assert.equal(telemetry.stopReason, "end_turn");
    assert.equal(chat.filter((c) => c.type === "delta").map((c) => c.text).join(""), "Итог: готово.");
    assert.deepEqual(
      session.messages.map((m) => m.role),
      ["user", "assistant", "user", "assistant"],
    );
    assert.equal(session.busy, false);
  });

  it("renders a streamed render_surface progressively: the surface exists before the arguments finish", async () => {
    const { session } = controlSession();
    const tree = '{"id":"root","component":"Column","children":["t"]},{"id":"t","component":"Text","text":"Привет"}';
    const parts = sse(
      call(0, { id: "r1", name: "render_surface", args: '{"surfaceId":"bill","components":[' }),
      call(0, { args: tree }),
      call(0, { args: "]}" }),
      finish("tool_calls"),
    );

    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let releasedBy: "envelope" | "timeout" | undefined;
    const release_ = (by: "envelope" | "timeout") => {
      releasedBy ??= by;
      release();
    };
    const timer = setTimeout(() => release_("timeout"), 1500);
    session.subscribe((event, data) => {
      if (event === "a2ui" && "createSurface" in (data as object)) release_("envelope");
    });

    let i = 0;
    const gated = () =>
      new Response(
        new ReadableStream<Uint8Array>({
          async pull(controller) {
            if (i === 1) await gate; // hold everything after the first chunk until the client saw the surface
            if (i >= parts.length) return controller.close();
            controller.enqueue(enc.encode(parts[i++]));
          },
        }),
        { status: 200 },
      );
    const { impl } = fakeFetch(gated, ok(sse(text("Готово"), finish("stop"))));

    const telemetry = await runTurn(session, "нарисуй", { client: client(impl), llm: LLM });
    clearTimeout(timer);

    assert.equal(releasedBy, "envelope", "createSurface reached the client while the model was still writing");
    assert.equal(telemetry.error, undefined);
    assert.ok(telemetry.messageCounts.createSurface >= 1);
    assert.ok(telemetry.messageCounts.updateComponents >= 1);
    assert.ok(telemetry.messageCounts.updateDataModel >= 1);
    assert.equal(telemetry.validationRepairs, 0);
    assert.ok(session.surfaces.has("bill"));
  });

  it("shows a refusal and keeps the history consistent", async () => {
    const { session } = controlSession();
    const chat: string[] = [];
    session.subscribe((event, data) => event === "chat" && chat.push(JSON.stringify(data)));
    const { impl } = fakeFetch(ok(sse(finish("content_filter"))));
    const telemetry = await runTurn(session, "что-то", { client: client(impl), llm: LLM });
    assert.equal(telemetry.stopReason, "refusal");
    assert.ok(chat.some((c) => c.includes("отказалась")));
    assert.equal(session.messages.at(-1)?.role, "assistant");
    assert.equal(session.busy, false);
  });

  it("rolls the turn back on an API failure", async () => {
    const { session } = controlSession();
    const errors: unknown[] = [];
    session.subscribe((event, data) => event === "error" && errors.push(data));
    const telemetry = await runTurn(session, "привет", { client: client(fakeFetch(apiError(401, "invalid API token")).impl), llm: LLM });
    assert.equal(errors.length, 1);
    assert.ok(telemetry.error);
    assert.equal(session.messages.length, 0);
    assert.equal(session.busy, false);
  });

  it("re-issues the request once when the model sends unparseable tool JSON", async () => {
    const { session } = controlSession();
    const { impl, calls } = fakeFetch(
      ok(sse(call(0, { id: "c", name: "get_summary", args: '{"broken":' }), finish("tool_calls"))),
      ok(sse(call(0, { id: "c2", name: "get_summary", args: "{}" }), finish("tool_calls"))),
      ok(sse(text("ок"), finish("stop"))),
    );
    const telemetry = await runTurn(session, "итог", { client: client(impl), llm: LLM });
    assert.equal(telemetry.error, undefined);
    assert.equal(calls.length, 3);
    assert.deepEqual(
      session.messages.map((m) => m.role),
      ["user", "assistant", "user", "assistant"],
    );
  });
});
