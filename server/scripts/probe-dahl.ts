// Live probe of the Dahl API (LLM_PROVIDER=dahl): checks the assumptions A1–A7 behind
// server/src/agent/dahl.ts against the real service. Needs DAHL_API_KEY in .env for the chat
// probes; without it only the public endpoints and the 401 shape are probed.
// The key is only ever sent in the Authorization header, never printed or written.
// Usage: npm -w server run probe:dahl
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config, dahlApiKey } from "../src/config.js";
import { Session } from "../src/agent/session.js";
import { buildTools } from "../src/agent/tools.js";

process.env.LOG_LEVEL ??= "warn";
if (config.llm.provider !== "dahl") {
  console.error(`[probe] LLM_PROVIDER is "${config.llm.provider}"; the probe only talks to Dahl (unset LLM_PROVIDER or set it to dahl).`);
  process.exit(1);
}
const { baseURL, model } = config.llm;
const key = dahlApiKey();
const RAW_LIMIT = 300;
const clip = (text: string) => (text.length > RAW_LIMIT ? `${text.slice(0, RAW_LIMIT)}…` : text);

interface SseEvent {
  atMs: number;
  data: string;
}

/** POSTs a chat completion and returns status + (for 2xx) the SSE events, or the error body. */
async function chat(body: Record<string, unknown>, apiKey: string | undefined) {
  const started = performance.now();
  const res = await fetch(`${baseURL}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "text/event-stream", ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(180_000),
  });
  const headersMs = Math.round(performance.now() - started);
  const contentType = res.headers.get("content-type");
  if (!res.ok || !res.body) return { status: res.status, headersMs, contentType, errorBody: clip(await res.text()), events: [] as SseEvent[] };

  const events: SseEvent[] = [];
  const decoder = new TextDecoder();
  let buffer = "";
  const take = (line: string) => {
    if (line.startsWith("data:")) events.push({ atMs: Math.round(performance.now() - started), data: line.slice(5).trim() });
  };
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      take(buffer.slice(0, nl).replace(/\r$/, ""));
      buffer = buffer.slice(nl + 1);
    }
  }
  if (buffer.trim()) take(buffer.trim());
  return { status: res.status, headersMs, contentType, errorBody: undefined, events };
}

interface Chunk {
  model?: string;
  choices?: Array<{ delta?: Record<string, unknown>; finish_reason?: string | null }>;
  usage?: Record<string, unknown> | null;
  error?: unknown;
}

/** Condenses a stream into the facts the adapter depends on. */
function analyze(events: SseEvent[]) {
  const deltaKeys = new Set<string>();
  const finishReasons: string[] = [];
  const tools = new Map<number, { idChunks: number; nameChunks: number; argChunks: number; argChars: number; ids: Set<string> }>();
  let content = "";
  let contentChunks = 0;
  let reasoningChunks = 0;
  let usage: Record<string, unknown> | undefined;
  let usageChunk: number | undefined;
  let echoedModel: string | undefined;
  let errorChunk: unknown;
  let doneSeen = false;
  let unparsed = 0;

  events.forEach((event, i) => {
    if (event.data === "[DONE]") {
      doneSeen = true;
      return;
    }
    let chunk: Chunk;
    try {
      chunk = JSON.parse(event.data) as Chunk;
    } catch {
      unparsed++;
      return;
    }
    if (chunk.error) errorChunk = chunk.error;
    if (chunk.model) echoedModel = chunk.model;
    if (chunk.usage) {
      usage = chunk.usage;
      usageChunk = i;
    }
    for (const choice of chunk.choices ?? []) {
      if (choice.finish_reason) finishReasons.push(choice.finish_reason);
      const delta = choice.delta ?? {};
      for (const k of Object.keys(delta)) deltaKeys.add(k);
      if (typeof delta.content === "string" && delta.content) {
        content += delta.content;
        contentChunks++;
      }
      if (delta.reasoning_content || delta.reasoning) reasoningChunks++;
      for (const call of (delta.tool_calls as Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }> | undefined) ?? []) {
        const index = call.index ?? -1;
        const t = tools.get(index) ?? { idChunks: 0, nameChunks: 0, argChunks: 0, argChars: 0, ids: new Set<string>() };
        if (call.id) {
          t.idChunks++;
          t.ids.add(call.id);
        }
        if (call.function?.name) t.nameChunks++;
        if (call.function?.arguments) {
          t.argChunks++;
          t.argChars += call.function.arguments.length;
        }
        tools.set(index, t);
      }
    }
  });

  return {
    chunks: events.length,
    firstChunkMs: events[0]?.atMs ?? null,
    lastChunkMs: events.at(-1)?.atMs ?? null,
    doneSeen,
    unparsed,
    echoedModel,
    deltaKeys: [...deltaKeys],
    finishReasons,
    contentChunks,
    contentSample: clip(content),
    thinkTagInContent: /<\/?think>/i.test(content),
    reasoningChunks,
    usage,
    usageInChunk: usageChunk === undefined ? null : `${usageChunk + 1}/${events.length}`,
    errorChunk,
    tools: [...tools.entries()].map(([index, t]) => ({ index, ...t, ids: [...t.ids] })),
    rawFirst: events.slice(0, 3).map((e) => clip(e.data)),
    rawLast: events.slice(-3).map((e) => clip(e.data)),
  };
}

const report: Record<string, unknown> = { baseURL, model, keyPresent: Boolean(key), at: new Date().toISOString() };

// 1. public model list
{
  const res = await fetch(`${baseURL}/models`, { signal: AbortSignal.timeout(10_000) });
  const body = (await res.json().catch(() => ({}))) as { data?: Array<{ id: string }> };
  const ids = (body.data ?? []).map((m) => m.id);
  report.models = { status: res.status, ids, configuredModelListed: ids.includes(model) };
}

// 4a. error shape: an invalid key (never the real one)
{
  const r = await chat({ model, messages: [{ role: "user", content: "hi" }], max_tokens: 1 }, "invalid-probe-key");
  report.errorInvalidKey = { status: r.status, contentType: r.contentType, body: r.errorBody };
}

if (!key) {
  report.skipped = "no DAHL_API_KEY: chat probes (plain stream, tool stream, unknown model) not run";
} else {
  // 2. plain streamed request (A1, A3, A4, A5)
  {
    const r = await chat(
      {
        model,
        messages: [{ role: "user", content: "Ответь одним словом: ок" }],
        max_tokens: 32000,
        stream: true,
        stream_options: { include_usage: true },
      },
      key,
    );
    report.plainStream = { status: r.status, headersMs: r.headersMs, contentType: r.contentType, errorBody: r.errorBody, ...(r.events.length ? analyze(r.events) : {}) };
  }

  // 3. tool call stream with the raw (not inlined) zod schemas, the worst case for A2/A6
  {
    const tools = (buildTools(new Session("probe")) as unknown as Array<{ name: string; description: string; input_schema: unknown }>)
      .filter((t) => t.name === "create_bill" || t.name === "render_surface")
      .map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.input_schema } }));
    const r = await chat(
      {
        model,
        messages: [
          { role: "system", content: "Ты агент приложения для дележа счёта. Вызывай инструменты, не пересказывай их." },
          { role: "user", content: "Создай счёт «Тест»: участники Аня и Боря, позиция «Чай» 100, платила Аня." },
        ],
        tools,
        max_tokens: 32000,
        stream: true,
        stream_options: { include_usage: true },
      },
      key,
    );
    report.toolStream = { status: r.status, headersMs: r.headersMs, contentType: r.contentType, errorBody: r.errorBody, ...(r.events.length ? analyze(r.events) : {}) };
  }

  // 4b. error shape: an unknown model with the real key
  {
    const r = await chat({ model: "probe/does-not-exist", messages: [{ role: "user", content: "hi" }], max_tokens: 1 }, key);
    report.errorUnknownModel = { status: r.status, contentType: r.contentType, body: r.errorBody };
  }
}

const outDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../bench");
fs.mkdirSync(outDir, { recursive: true });
const file = path.join(outDir, `probe-dahl-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
fs.writeFileSync(file, JSON.stringify(report, null, 2));
console.info(JSON.stringify(report, null, 2));
console.info(`[probe] written ${file}`);
