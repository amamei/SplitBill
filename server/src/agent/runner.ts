// One agent turn: tool runner (streaming) over the session's conversation — the Dahl inference API
// (./dahl.ts), Claude, or a local Ollama model (Anthropic-compatible API), all behind the same
// `client.beta.messages.toolRunner` surface and the same tools (see ./llm.ts).
// History is append-only (prompt cache + preserved thinking): UI-side changes reach the
// model as a state-sync text block in the next user message, never by editing history.
import Anthropic from "@anthropic-ai/sdk";
import type { BetaContentBlockParam, BetaMessageParam } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { config, type LlmConfig } from "../config.js";
import { createScope } from "../log.js";
import { formatMinor } from "../domain/money.js";
import { splitText } from "../projector/project.js";
import { buildSystemPrompt, promptVersion } from "./prompt.js";
import type { Session } from "./session.js";
import { TurnRecorder, type TurnTelemetry } from "./telemetry.js";
import { buildTools } from "./tools.js";
import { createRenderStreamer, type RenderStreamer } from "./render-stream.js";
import { describeLlmError, getLlmClient, providerParams, TruncatedToolInput } from "./llm.js";

const logger = createScope("agent.turn");
export const STATE_SYNC_PREFIX = "[Состояние счёта изменено через интерфейс]";
const MAX_JSON_RETRIES = 2;

export type UserContent = string | BetaContentBlockParam[];
type ClaudeClient = Pick<Anthropic, "beta">;

export class SessionBusyError extends Error {
  constructor() {
    super("Агент ещё отвечает на предыдущее сообщение");
  }
}

/** Compact text summary of the current bill for the state-sync block. */
export function stateSummary(session: Session): string {
  const bill = session.store.getBill(session.billId!);
  const summary = session.store.getSummary(bill.id);
  const name = (id: string) => bill.people.find((p) => p.id === id)?.name ?? id;
  const lines = [
    `Участники: ${bill.people.map((p) => p.name).join(", ") || "—"}`,
    "Позиции:",
    ...bill.items.map((i) => `- ${i.title} ${formatMinor(i.price)}, платил ${name(i.paidById)}, ${splitText(i.split, bill.people)}`),
    `Балансы: ${summary.people.map((p) => `${p.name} ${formatMinor(p.balance, { sign: true })}`).join(", ")}`,
    `Переводы: ${summary.transfers.map((t) => `${name(t.fromId)} → ${name(t.toId)} ${formatMinor(t.amount)}`).join("; ") || "нет"}`,
  ];
  return `${STATE_SYNC_PREFIX}\n${lines.join("\n")}`;
}

export async function runTurn(
  session: Session,
  userContent: UserContent,
  opts: { kind?: TurnTelemetry["kind"]; client?: ClaudeClient; llm?: LlmConfig } = {},
): Promise<TurnTelemetry> {
  if (session.busy) throw new SessionBusyError();
  session.busy = true;
  const llm = opts.llm ?? config.llm;
  const client = opts.client ?? getLlmClient();
  const turn = ++session.turnCounter;
  const recorder = new TurnRecorder(turn, opts.kind ?? "chat", llm.model, promptVersion());
  session.recorder = recorder;

  const historyBefore = session.messages.length;
  const seenBefore = session.modelSeenVersion;
  const blocks: BetaContentBlockParam[] = typeof userContent === "string" ? [{ type: "text", text: userContent }] : [...userContent];
  const stateSynced = Boolean(session.billId) && session.store.version > session.modelSeenVersion;
  if (stateSynced) {
    blocks.unshift({ type: "text", text: stateSummary(session) });
    session.modelSeenVersion = session.store.version;
  }
  session.messages.push({ role: "user", content: blocks });
  logger.info("start", { session: session.id, turn, provider: llm.provider, model: llm.model, stateSynced, storeVersion: session.store.version });

  const streamer: RenderStreamer = createRenderStreamer(session, { enabled: config.stream });
  let runner = client.beta.messages.toolRunner({
    model: llm.model,
    max_tokens: 32000,
    tools: buildTools(session),
    messages: [...session.messages],
    stream: true,
    ...providerParams(llm, buildSystemPrompt()),
  });

  let failed = false;
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        for await (const stream of runner) {
          for await (const event of stream) {
            if (event.type === "content_block_start" && event.content_block.type === "tool_use") {
              logger.debug("tool_use start", { name: event.content_block.name, id: event.content_block.id });
              streamer.start(event.index, event.content_block.id, event.content_block.name);
            } else if (event.type === "content_block_delta") {
              if (event.delta.type === "text_delta") {
                recorder.text();
                session.send("chat", { type: "delta", turn, text: event.delta.text });
              } else if (event.delta.type === "input_json_delta") {
                streamer.delta(event.index, event.delta.partial_json);
              }
            } else if (event.type === "content_block_stop") {
              streamer.stop(event.index);
            }
          }
          const message = await stream.finalMessage();
          attempt = 0;
          recorder.usage(message.usage);
          recorder.data.stopReason = message.stop_reason;
          if (message.model !== llm.model) recorder.data.model = message.model; // served by a fallback
          logger.debug("iteration", { turn, stopReason: message.stop_reason, usage: message.usage });
          const hasToolUse = message.content.some((b) => b.type === "tool_use");
          if (message.stop_reason === "max_tokens" && hasToolUse) throw new TruncatedToolInput("tool input truncated at max_tokens");
          if (message.stop_reason === "refusal") {
            logger.warn("refusal", { turn, details: message.stop_details });
            session.send("chat", { type: "delta", turn, text: "\n(Модель отказалась отвечать на этот запрос.)" });
            streamer.abortAll();
            break;
          }
        }
        break;
      } catch (err) {
        streamer.abortAll();
        if (!isToolJsonError(err) || attempt >= MAX_JSON_RETRIES) throw err;
        logger.warn("unparseable tool input, re-issuing the turn", { turn, attempt, err: String(err) });
        runner = client.beta.messages.toolRunner({ ...runner.params });
      }
    }
    session.messages = [...(runner.params.messages as BetaMessageParam[])];
    logger.debug("history", { turn, messages: session.messages.length, lastRole: session.messages.at(-1)?.role });
  } catch (err) {
    failed = true;
    recorder.data.error = describeLlmError(err, llm);
    logger.error("failed", { turn, provider: llm.provider, status: (err as { status?: number }).status, err: err instanceof Error ? err.message : String(err) });
    session.send("error", { turn, message: recorder.data.error });
  } finally {
    streamer.abortAll();
    if (failed) {
      // Drop the failed turn from history (never edit earlier messages); domain changes it made
      // stay in the store and reach the model through the next state-sync block.
      session.messages = session.messages.slice(0, historyBefore);
      session.modelSeenVersion = Math.min(seenBefore, session.modelSeenVersion);
    }
    const telemetry = recorder.finish();
    session.telemetry.push(telemetry);
    session.recorder = undefined;
    session.busy = false;
    session.send("chat", { type: "done", turn });
    session.send("status", telemetry);
    logger.info("end", telemetry);
  }
  return recorder.data;
}

// The SDK has no dedicated class for this: it arrives as a bare AnthropicError (not an
// APIError), told apart by message.

/** Tool input the SDK could not parse at all (eager input streaming): safe to re-issue. */
function isToolJsonError(err: unknown): boolean {
  return err instanceof Anthropic.AnthropicError && !(err instanceof Anthropic.APIError) && /tool parameter JSON/i.test(err.message);
}
