// One agent turn: Claude tool runner (streaming) over the session's conversation.
// History is append-only (prompt cache + preserved thinking): UI-side changes reach the
// model as a state-sync text block in the next user message, never by editing history.
import Anthropic from "@anthropic-ai/sdk";
import type { BetaContentBlockParam, BetaMessageParam } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { config } from "../config.js";
import { createScope } from "../log.js";
import { formatMinor } from "../domain/money.js";
import { splitText } from "../projector/project.js";
import { buildSystemPrompt, promptVersion } from "./prompt.js";
import type { Session } from "./session.js";
import { TurnRecorder, type TurnTelemetry } from "./telemetry.js";
import { buildTools } from "./tools.js";
import { createRenderStreamer, type RenderStreamer } from "./render-stream.js";

const logger = createScope("agent.turn");
export const STATE_SYNC_PREFIX = "[Состояние счёта изменено через интерфейс]";
const MAX_JSON_RETRIES = 2;

export type UserContent = string | BetaContentBlockParam[];
type ClaudeClient = Pick<Anthropic, "beta">;

let defaultClient: Anthropic | undefined;
function getClient(): Anthropic {
  defaultClient ??= new Anthropic();
  return defaultClient;
}

export class SessionBusyError extends Error {
  constructor() {
    super("Агент ещё отвечает на предыдущее сообщение");
  }
}

class TruncatedToolInput extends Error {}

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
  opts: { kind?: TurnTelemetry["kind"]; client?: ClaudeClient } = {},
): Promise<TurnTelemetry> {
  if (session.busy) throw new SessionBusyError();
  session.busy = true;
  const client = opts.client ?? getClient();
  const turn = ++session.turnCounter;
  const recorder = new TurnRecorder(turn, opts.kind ?? "chat", config.model, promptVersion());
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
  logger.info("start", { session: session.id, turn, model: config.model, stateSynced, storeVersion: session.store.version });

  const streamer: RenderStreamer = createRenderStreamer(session, { enabled: config.stream });
  let runner = client.beta.messages.toolRunner({
    model: config.model,
    max_tokens: 32000,
    system: [{ type: "text", text: buildSystemPrompt(), cache_control: { type: "ephemeral" } }],
    tools: buildTools(session),
    messages: [...session.messages],
    stream: true,
    output_config: { effort: config.effort },
    ...(config.fallbacks ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
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
          if (message.model !== config.model) recorder.data.model = message.model; // served by a fallback
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
    recorder.data.error = describeError(err);
    logger.error("failed", { turn, status: err instanceof Anthropic.APIError ? err.status : undefined, err: err instanceof Error ? err.message : String(err) });
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

// The SDK has no dedicated classes for these two: both arrive as a bare AnthropicError
// (not an APIError), so they are told apart by message / cause.

/** Tool input the SDK could not parse at all (eager input streaming): safe to re-issue. */
function isToolJsonError(err: unknown): boolean {
  return err instanceof Anthropic.AnthropicError && !(err instanceof Anthropic.APIError) && /tool parameter JSON/i.test(err.message);
}

/** No credential source resolved (no ANTHROPIC_API_KEY / auth token / `ant` profile). */
function isMissingCredentials(err: unknown): boolean {
  const cause = err instanceof Error ? (err.cause as unknown) : undefined;
  return [err, cause].some((e) => e instanceof Error && /resolve authentication method/i.test(e.message));
}

function describeError(err: unknown): string {
  if (err instanceof Anthropic.AuthenticationError) return "Нет доступа к Anthropic API. Выполните `ant auth login` (или задайте ANTHROPIC_API_KEY) и перезапустите сервер.";
  if (err instanceof Anthropic.PermissionDeniedError) return "Нет прав на модель или функцию API (403).";
  if (err instanceof Anthropic.RateLimitError) return "Превышен лимит запросов к API, попробуйте через минуту.";
  if (err instanceof Anthropic.BadRequestError) return `Некорректный запрос к API: ${err.message}`;
  if (err instanceof Anthropic.APIError) return `Ошибка API ${err.status ?? ""}: ${err.message}`;
  if (err instanceof TruncatedToolInput) return "Ответ модели обрезан (max_tokens) посреди вызова инструмента.";
  if (isMissingCredentials(err)) {
    return "Нет учётных данных Anthropic. Выполните `ant auth login` (или задайте ANTHROPIC_API_KEY) и перезапустите сервер.";
  }
  return `Ошибка: ${err instanceof Error ? err.message : String(err)}`;
}
