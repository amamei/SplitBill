import { describe, it } from "node:test";
import assert from "node:assert/strict";
import Anthropic from "@anthropic-ai/sdk";
import type { LlmConfig } from "../../config.js";
import { dispatchAction } from "../actions.js";
import { DahlApiError, DahlMissingKeyError } from "../dahl.js";
import { runTurn, STATE_SYNC_PREFIX } from "../runner.js";
import { action, controlSession } from "./helpers.js";

const ANTHROPIC = { provider: "anthropic", model: "claude-opus-5-5", effort: "medium", fallbacks: true } as const satisfies LlmConfig;
const OLLAMA = { provider: "ollama", model: "m", baseURL: "http://x" } as const satisfies LlmConfig;
const DAHL = { provider: "dahl", model: "MiniMaxAI/MiniMax-M2.7", baseURL: "https://dahl.test/v1" } as const satisfies LlmConfig;

type Params = { messages: Array<{ role: string; content: unknown }> } & Record<string, unknown>;

/** Minimal stand-in for client.beta.messages.toolRunner: one streamed text reply, no tools. */
function stubClient(reply = "Готово.") {
  const calls: Params[] = [];
  const client = {
    beta: {
      messages: {
        toolRunner(params: Params) {
          calls.push({ ...params, messages: structuredClone(params.messages) });
          const finalMessage = {
            id: "msg_1",
            type: "message",
            role: "assistant",
            model: params.model,
            content: [{ type: "text", text: reply }],
            stop_reason: "end_turn",
            stop_details: null,
            usage: { input_tokens: 10, output_tokens: 3, cache_read_input_tokens: 5, cache_creation_input_tokens: 0 },
          };
          const state = { messages: [...params.messages] };
          return {
            get params() {
              return { ...params, messages: state.messages };
            },
            async *[Symbol.asyncIterator]() {
              yield {
                async *[Symbol.asyncIterator]() {
                  yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: reply } };
                },
                finalMessage: async () => finalMessage,
              };
              state.messages.push({ role: "assistant", content: finalMessage.content });
            },
          };
        },
      },
    },
  };
  return { client: client as unknown as Pick<Anthropic, "beta">, calls };
}

describe("runTurn", () => {
  it("prepends a state-sync block after a UI change and keeps earlier history byte-identical", async () => {
    const { session, ids } = controlSession();
    session.messages = [
      { role: "user", content: [{ type: "text", text: "старый запрос" }] },
      { role: "assistant", content: [{ type: "text", text: "старый ответ" }] },
    ];
    const historyBefore = JSON.stringify(session.messages);
    dispatchAction(session, action("set_payer", { personId: ids.people.gena }));
    assert.ok(session.store.version > session.modelSeenVersion);

    const { client, calls } = stubClient();
    const chat: unknown[] = [];
    session.subscribe((event, data) => event === "chat" && chat.push(data));
    const telemetry = await runTurn(session, "покажи итог", { client });

    const sent = calls[0].messages;
    assert.equal(JSON.stringify(sent.slice(0, 2)), historyBefore);
    const userBlocks = sent[2].content as Array<{ type: string; text: string }>;
    assert.ok(userBlocks[0].text.startsWith(STATE_SYNC_PREFIX));
    assert.match(userBlocks[0].text, /Еда 1200\.00, платил Гена/);
    assert.equal(userBlocks[1].text, "покажи итог");
    assert.equal(session.modelSeenVersion, session.store.version);
    assert.equal(session.messages.length, 4, "assistant reply appended");
    assert.equal(telemetry.tokens.output, 3);
    assert.equal(telemetry.tokens.cacheRead, 5);
    assert.ok(chat.some((c) => (c as { type: string }).type === "delta"));
    assert.equal(session.busy, false);
  });

  it("adds no state block when nothing changed in the UI", async () => {
    const { session } = controlSession();
    const { client, calls } = stubClient();
    await runTurn(session, "привет", { client });
    const blocks = calls[0].messages[0].content as Array<{ text: string }>;
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].text, "привет");
  });

  it("sends the cached system prompt, streaming and effort", async () => {
    const { session } = controlSession();
    const { client, calls } = stubClient();
    await runTurn(session, "привет", { client, llm: ANTHROPIC });
    const p = calls[0] as Params & { system: Array<{ cache_control?: unknown }>; stream: boolean; output_config: { effort: string }; tools: Array<{ name: string; eager_input_streaming?: boolean }> };
    assert.deepEqual(p.system[0].cache_control, { type: "ephemeral" });
    assert.equal(p.stream, true);
    assert.ok(p.output_config.effort);
    assert.equal(p.tools.find((t) => t.name === "render_surface")!.eager_input_streaming, true);
    assert.equal(p.thinking, undefined);
    assert.equal(p.tool_choice, undefined);
  });

  it("sends Ollama the plain request: no effort, betas, fallbacks or cache_control", async () => {
    const { session } = controlSession();
    const { client, calls } = stubClient();
    const telemetry = await runTurn(session, "привет", { client, llm: OLLAMA });
    const p = calls[0] as Params & { system: Array<{ cache_control?: unknown }> };
    assert.equal(p.model, "m");
    assert.equal(p.output_config, undefined);
    assert.equal(p.betas, undefined);
    assert.equal(p.fallbacks, undefined);
    assert.equal(p.system[0].cache_control, undefined);
    assert.equal(p.stream, true);
    assert.equal(telemetry.model, "m");
  });

  it("sends Dahl the plain request too: no effort, betas, fallbacks or cache_control", async () => {
    const { session } = controlSession();
    const { client, calls } = stubClient();
    const telemetry = await runTurn(session, "привет", { client, llm: DAHL });
    const p = calls[0] as Params & { system: Array<{ text: string; cache_control?: unknown }> };
    assert.equal(p.model, DAHL.model);
    assert.equal(p.output_config, undefined);
    assert.equal(p.betas, undefined);
    assert.equal(p.fallbacks, undefined);
    assert.equal(p.system[0].cache_control, undefined);
    assert.ok(p.system[0].text.length > 1000, "the full system prompt is still sent");
    assert.equal(p.stream, true);
    assert.equal(telemetry.model, DAHL.model);
  });

  it("an API failure drops the turn from history and reports an error event", async () => {
    const { session } = controlSession();
    const errors: unknown[] = [];
    session.subscribe((event, data) => event === "error" && errors.push(data));
    const client = {
      beta: {
        messages: {
          toolRunner(params: Params) {
            return {
              params,
              async *[Symbol.asyncIterator]() {
                throw new Error("boom");
              },
            };
          },
        },
      },
    } as unknown as Pick<Anthropic, "beta">;
    const telemetry = await runTurn(session, "привет", { client });
    assert.equal(session.messages.length, 0);
    assert.match(String(telemetry.error), /boom/);
    assert.equal(errors.length, 1);
    assert.equal(session.busy, false);
  });

  it("an unreachable Ollama shows how to start it and rolls the turn back", async () => {
    const { session } = controlSession();
    const errors: Array<{ message: string }> = [];
    session.subscribe((event, data) => event === "error" && errors.push(data as { message: string }));
    const client = {
      beta: {
        messages: {
          toolRunner(params: Params) {
            return {
              params,
              async *[Symbol.asyncIterator]() {
                throw new Anthropic.APIConnectionError({ message: "Connection error." });
              },
            };
          },
        },
      },
    } as unknown as Pick<Anthropic, "beta">;
    await runTurn(session, "привет", { client, llm: OLLAMA });
    assert.equal(errors.length, 1);
    assert.match(errors[0].message, /ollama serve/);
    assert.equal(session.messages.length, 0);
    assert.equal(session.busy, false);
  });
  const failingClient = (error: unknown) =>
    ({
      beta: {
        messages: {
          toolRunner(params: Params) {
            return {
              params,
              async *[Symbol.asyncIterator]() {
                throw error;
              },
            };
          },
        },
      },
    }) as unknown as Pick<Anthropic, "beta">;

  it("a rejected Dahl key points at DAHL_API_KEY and rolls the turn back", async () => {
    const { session } = controlSession();
    const errors: Array<{ message: string }> = [];
    session.subscribe((event, data) => event === "error" && errors.push(data as { message: string }));
    const telemetry = await runTurn(session, "привет", { client: failingClient(new DahlApiError(401, "invalid API token")), llm: DAHL });
    assert.equal(errors.length, 1);
    assert.match(errors[0].message, /DAHL_API_KEY/);
    assert.match(String(telemetry.error), /не принял ключ \(401\)/);
    assert.equal(session.messages.length, 0);
    assert.equal(session.busy, false);
  });

  it("a missing Dahl key tells how to add it", async () => {
    const { session } = controlSession();
    const errors: Array<{ message: string }> = [];
    session.subscribe((event, data) => event === "error" && errors.push(data as { message: string }));
    await runTurn(session, "привет", { client: failingClient(new DahlMissingKeyError()), llm: DAHL });
    assert.match(errors[0].message, /Не задан DAHL_API_KEY.*\.env/);
    assert.equal(session.busy, false);
  });
});
