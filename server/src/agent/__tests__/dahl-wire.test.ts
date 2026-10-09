import { describe, it } from "node:test";
import assert from "node:assert/strict";
import Anthropic from "@anthropic-ai/sdk";
import type { BetaMessageParam } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { buildTools } from "../tools.js";
import {
  extractErrorMessage,
  inlineRefs,
  mapFinishReason,
  parseSse,
  parseToolArguments,
  systemText,
  ThinkFilter,
  toOpenAiMessages,
  toOpenAiTools,
  UnsupportedContentError,
  usageFromOpenAi,
  type ToolDef,
} from "../dahl-wire.js";
import { controlSession } from "./helpers.js";

const enc = new TextEncoder();

async function* chunks(parts: Array<string | Uint8Array>): AsyncGenerator<Uint8Array> {
  for (const part of parts) yield typeof part === "string" ? enc.encode(part) : part;
}

async function collect(gen: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const item of gen) out.push(item);
  return out;
}

describe("toOpenAiMessages", () => {
  const history: BetaMessageParam[] = [
    { role: "user", content: [{ type: "text", text: "[Состояние счёта изменено через интерфейс]\nУчастники: Аня" }, { type: "text", text: "покажи итог" }] },
    {
      role: "assistant",
      content: [
        { type: "text", text: "Смотрю. " },
        { type: "tool_use", id: "t1", name: "get_summary", input: {} },
        { type: "tool_use", id: "t2", name: "add_person", input: { name: "Боря" } },
      ],
    },
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "t1", content: '{"ok":true}' },
        { type: "tool_result", tool_use_id: "t2", content: [{ type: "text", text: "ошибка" }], is_error: true },
      ],
    },
    { role: "assistant", content: [{ type: "text", text: "Готово." }] },
  ];

  it("maps system, user, assistant tool calls and one tool message per call, in order", () => {
    const messages = toOpenAiMessages("SYS", history);
    assert.deepEqual(messages, [
      { role: "system", content: "SYS" },
      { role: "user", content: "[Состояние счёта изменено через интерфейс]\nУчастники: Аня\n\nпокажи итог" },
      {
        role: "assistant",
        content: "Смотрю. ",
        tool_calls: [
          { id: "t1", type: "function", function: { name: "get_summary", arguments: "{}" } },
          { id: "t2", type: "function", function: { name: "add_person", arguments: '{"name":"Боря"}' } },
        ],
      },
      { role: "tool", tool_call_id: "t1", content: '{"ok":true}' },
      { role: "tool", tool_call_id: "t2", content: "ошибка" },
      { role: "assistant", content: "Готово." },
    ]);
  });

  it("puts tool messages before the user text of the same message", () => {
    const messages = toOpenAiMessages(undefined, [
      { role: "user", content: [{ type: "text", text: "после" }, { type: "tool_result", tool_use_id: "t1", content: "r" }] },
    ]);
    assert.deepEqual(
      messages.map((m) => m.role),
      ["tool", "user"],
    );
  });

  it("gives an assistant message with only tool calls null content, and omits an absent system prompt", () => {
    const messages = toOpenAiMessages(undefined, [{ role: "assistant", content: [{ type: "tool_use", id: "t1", name: "get_summary", input: {} }] }]);
    assert.equal(messages.length, 1);
    assert.equal(messages[0].role === "assistant" && messages[0].content, null);
  });

  it("drops reasoning blocks and passes string content through", () => {
    const messages = toOpenAiMessages(undefined, [
      { role: "user", content: "привет" },
      { role: "assistant", content: [{ type: "thinking", thinking: "hm", signature: "s" }, { type: "text", text: "ответ" }] },
    ]);
    assert.deepEqual(messages, [
      { role: "user", content: "привет" },
      { role: "assistant", content: "ответ" },
    ]);
  });

  it("refuses an image: no Dahl model has vision", () => {
    assert.throws(
      () => toOpenAiMessages(undefined, [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "AA==" } }] }]),
      (err: unknown) => err instanceof UnsupportedContentError && err.kind === "image",
    );
  });

  it("sends an image as an image_url part when images are allowed, keeping text-only users as a string", () => {
    const messages = toOpenAiMessages(
      undefined,
      [
        { role: "user", content: [{ type: "text", text: "чек" }, { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "/9j/" } }] },
        { role: "user", content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] },
        { role: "user", content: [{ type: "image", source: { type: "url", url: "https://x/y.png" } }] },
      ],
      { allowImages: true },
    );
    assert.deepEqual(messages, [
      { role: "user", content: [{ type: "text", text: "чек" }, { type: "image_url", image_url: { url: "data:image/jpeg;base64,/9j/" } }] },
      { role: "user", content: "a\n\nb" },
      { role: "user", content: [{ type: "image_url", image_url: { url: "https://x/y.png" } }] },
    ]);
  });

  it("reads the system prompt from a string or from text blocks", () => {
    assert.equal(systemText("a"), "a");
    assert.equal(systemText([{ type: "text", text: "a" }, { type: "text", text: "b" }]), "a\n\nb");
    assert.equal(systemText(undefined), undefined);
    assert.equal(systemText([]), undefined);
  });
});

describe("inlineRefs / toOpenAiTools", () => {
  it("inlines refs, keeps sibling descriptions on top, and drops $defs and $schema", () => {
    const schema = {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        who: { description: "Who paid", $ref: "#/$defs/person" },
        all: { type: "array", items: { $ref: "#/$defs/person" } },
      },
      $defs: { person: { description: "Person name", type: "string" } },
    };
    assert.deepEqual(inlineRefs(schema), {
      type: "object",
      properties: {
        who: { description: "Who paid", type: "string" },
        all: { type: "array", items: { description: "Person name", type: "string" } },
      },
    });
  });

  it("replaces a recursive ref by {} and leaves non-local refs alone", () => {
    const out = inlineRefs({ type: "object", properties: { next: { $ref: "#/$defs/node" }, far: { $ref: "https://x/y.json" } }, $defs: { node: { type: "object", properties: { next: { $ref: "#/$defs/node" } } } } });
    assert.deepEqual(out, {
      type: "object",
      properties: { next: { type: "object", properties: { next: {} } }, far: { $ref: "https://x/y.json" } },
    });
  });

  it("converts the real tool set: no $ref, $defs or $schema anywhere, shapes preserved", () => {
    const tools = buildTools(controlSession().session) as unknown as ToolDef[];
    const converted = toOpenAiTools(tools);
    assert.equal(converted.length, tools.length);
    for (const tool of converted) {
      const json = JSON.stringify(tool.function.parameters);
      assert.doesNotMatch(json, /\$ref|\$defs|\$schema/, tool.function.name);
      assert.equal(tool.type, "function");
      assert.equal(tool.function.parameters.type, "object");
    }
    const byName = Object.fromEntries(converted.map((t) => [t.function.name, t.function]));
    const render = byName.render_surface.parameters as { properties: Record<string, unknown> };
    assert.deepEqual(Object.keys(render.properties), ["surfaceId", "components", "data"]);
    const createBill = JSON.stringify(byName.create_bill.parameters);
    for (const type of ["equal", "exact", "shares"]) assert.match(createBill, new RegExp(`"const":"${type}"`));
    assert.match(createBill, /Who paid for this item/);
    assert.match(createBill, /Major units as a decimal string/);
    assert.equal("eager_input_streaming" in byName.render_surface, false);
  });
});

describe("parseSse", () => {
  const events = (...payloads: string[]) => payloads.map((p) => `data: ${p}\n\n`).join("");

  it("yields data payloads and stops at [DONE]", async () => {
    assert.deepEqual(await collect(parseSse(chunks([events('{"a":1}', '{"a":2}') + "data: [DONE]\n\n" + events('{"a":3}')]))), ['{"a":1}', '{"a":2}']);
  });

  it("handles \\r\\n, comment lines, multi-line data and a missing space after the colon", async () => {
    const body = ": keep-alive\r\n\r\ndata:{\"a\":1}\r\n\r\ndata: line1\r\ndata: line2\r\n\r\nevent: x\r\ndata: {\"b\":2}\r\n\r\n";
    assert.deepEqual(await collect(parseSse(chunks([body]))), ['{"a":1}', "line1\nline2", '{"b":2}']);
  });

  it("is independent of where the network splits the bytes, even inside a Cyrillic character", async () => {
    const bytes = enc.encode(events('{"t":"привет"}', '{"t":"мир"}') + "data: [DONE]\n\n");
    const expected = ['{"t":"привет"}', '{"t":"мир"}'];
    for (let cut = 1; cut < bytes.length; cut++) {
      assert.deepEqual(await collect(parseSse(chunks([bytes.slice(0, cut), bytes.slice(cut)]))), expected, `cut at ${cut}`);
    }
  });

  it("delivers a final event that lacks its blank line, and nothing for an empty body", async () => {
    assert.deepEqual(await collect(parseSse(chunks(['data: {"a":1}']))), ['{"a":1}']);
    assert.deepEqual(await collect(parseSse(chunks([]))), []);
  });
});

describe("ThinkFilter", () => {
  const run = (parts: string[]) => {
    const filter = new ThinkFilter();
    return parts.map((p) => filter.push(p)).join("") + filter.end();
  };
  const splits = (text: string) => Array.from({ length: text.length + 1 }, (_, i) => [text.slice(0, i), text.slice(i)]);

  it("strips a think span wherever the chunks are cut", () => {
    for (const parts of splits("a<think>x</think>b")) assert.equal(run(parts), "ab", JSON.stringify(parts));
  });

  it("trims the whitespace after the closing tag but keeps the answer", () => {
    for (const parts of splits("<think>\nрассуждаю\n</think>\n\nОтвет")) assert.equal(run(parts), "Ответ", JSON.stringify(parts));
  });

  it("drops an unterminated span and passes tag-free text through unchanged", () => {
    assert.equal(run(["a<think>never closed"]), "a");
    assert.equal(run(["Привет, ", "мир! 1 < 2"]), "Привет, мир! 1 < 2");
  });

  it("releases a held-back partial tag as text when the stream ends", () => {
    assert.equal(run(["abc<th"]), "abc<th");
  });

  it("handles several spans in one message", () => {
    assert.equal(run(["<think>a</think>x<think>b</think>y"]), "xy");
  });
});

describe("mapFinishReason", () => {
  it("maps OpenAI finish reasons to Anthropic stop reasons", () => {
    assert.equal(mapFinishReason("stop", false), "end_turn");
    assert.equal(mapFinishReason("tool_calls", true), "tool_use");
    assert.equal(mapFinishReason("length", false), "max_tokens");
    assert.equal(mapFinishReason("content_filter", false), "refusal");
  });

  it("treats a stop with tool calls as tool_use (servers differ)", () => {
    assert.equal(mapFinishReason("stop", true), "tool_use");
    assert.equal(mapFinishReason(null, true), "tool_use");
    assert.equal(mapFinishReason(undefined, false), "end_turn");
    assert.equal(mapFinishReason("something_new", false), "end_turn");
  });
});

describe("usageFromOpenAi", () => {
  it("maps tokens and moves cached tokens out of the input count", () => {
    assert.deepEqual(usageFromOpenAi({ prompt_tokens: 100, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 60 } }), {
      input_tokens: 40,
      output_tokens: 7,
      cache_read_input_tokens: 60,
      cache_creation_input_tokens: 0,
    });
  });

  it("works without details, and with nothing at all", () => {
    assert.deepEqual(usageFromOpenAi({ prompt_tokens: 5, completion_tokens: 2 }), { input_tokens: 5, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });
    assert.deepEqual(usageFromOpenAi(undefined), { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });
    assert.deepEqual(usageFromOpenAi({ prompt_tokens: 5, prompt_tokens_details: null }).input_tokens, 5);
  });
});

describe("parseToolArguments", () => {
  it("parses valid JSON and treats empty arguments as {}", () => {
    assert.deepEqual(parseToolArguments('{"a":[1,2]}', "tool_use"), { a: [1, 2] });
    assert.deepEqual(parseToolArguments("", "tool_use"), {});
    assert.deepEqual(parseToolArguments("  ", "tool_use"), {});
  });

  it("returns {} for truncated JSON on max_tokens, so the runner reports the truncation", () => {
    assert.deepEqual(parseToolArguments('{"components":[{"id":"ro', "max_tokens"), {});
  });

  it("throws the bare AnthropicError that runner.ts re-issues for other invalid JSON", () => {
    assert.throws(
      () => parseToolArguments('{"a":', "tool_use"),
      (err: unknown) => err instanceof Anthropic.AnthropicError && !(err instanceof Anthropic.APIError) && /tool parameter JSON/i.test(err.message),
    );
  });
});

describe("extractErrorMessage", () => {
  it("reads the documented Dahl 401 body", () => {
    assert.equal(extractErrorMessage('{"error":{"code":"invalid_api_key","message":"invalid API token","type":"authentication_error"}}\n'), "invalid API token");
  });

  it("reads message, detail and a string error", () => {
    assert.equal(extractErrorMessage('{"message":"m"}'), "m");
    assert.equal(extractErrorMessage('{"detail":"d"}'), "d");
    assert.equal(extractErrorMessage('{"error":"e"}'), "e");
  });

  it("falls back to the raw text, cut to 300 chars", () => {
    assert.equal(extractErrorMessage("  upstream timeout "), "upstream timeout");
    assert.equal(extractErrorMessage("x".repeat(500)).length, 301);
    assert.equal(extractErrorMessage('{"unexpected":true}'), '{"unexpected":true}');
  });
});
