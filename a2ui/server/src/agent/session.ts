// Per-browser-session state: one bill, UI selection, the last data model pushed to the
// client, the model conversation, and the A2UI envelope log (replayed on SSE reconnect).
// `reset()` wipes all of it in place ("Новый счёт") while SSE subscribers stay attached.
import type { BetaMessageParam } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { createScope } from "../log.js";
import { deleteSurface, envelopeType, type A2uiEnvelope } from "../a2ui/envelopes.js";
import { BillStore } from "../domain/store.js";
import type { BillViewModel } from "../projector/view-model.js";
import { projectBill, type UiState } from "../projector/project.js";
import type { TurnRecorder, TurnTelemetry } from "./telemetry.js";
import type { StreamedRender } from "./tools.js";

const logger = createScope("agent.session");

export type SseEventName = "a2ui" | "chat" | "status" | "error";
export type SessionSink = (event: SseEventName, data: unknown) => void;

export class Session {
  readonly id: string;
  /** Replaced (not mutated) by reset(); callers must re-read `session.store`, never cache it. */
  store = new BillStore();
  billId?: string;
  ui: UiState = {};
  /** Data model of the `bill` surface as last sent to the client. */
  lastVm?: BillViewModel;
  /** store.version the model has seen (via its own tool calls or a state-sync block). */
  modelSeenVersion = 0;
  messages: BetaMessageParam[] = [];
  telemetry: TurnTelemetry[] = [];
  readonly surfaces = new Set<string>();
  readonly envelopeLog: A2uiEnvelope[] = [];
  busy = false;
  turnCounter = 0;
  /** render_surface calls whose components were already streamed to the client, by tool_use id. */
  readonly streamedRenders = new Map<string, StreamedRender>();
  /** Recorder of the turn in progress, if any (counts envelopes). */
  recorder?: TurnRecorder;
  private readonly sinks = new Set<SessionSink>();

  constructor(id: string) {
    this.id = id;
  }

  /** Current bill projection (throws if there is no bill yet). */
  project(): BillViewModel {
    if (!this.billId) throw new Error("session has no bill");
    return projectBill(this.store.getBill(this.billId), this.ui);
  }

  subscribe(sink: SessionSink): () => void {
    this.sinks.add(sink);
    return () => this.sinks.delete(sink);
  }

  send(event: SseEventName, data: unknown): void {
    for (const sink of this.sinks) {
      try {
        sink(event, data);
      } catch (err) {
        logger.warn("sink failed", { session: this.id, event, err: String(err) });
      }
    }
  }

  /**
   * Logs, counts and forwards A2UI envelopes to every connected client. Envelopes count
   * towards `recorder` (default: the agent turn in progress, if any).
   */
  emit(envelopes: A2uiEnvelope[], recorder: TurnRecorder | undefined = this.recorder): void {
    for (const envelope of envelopes) {
      const type = envelopeType(envelope);
      this.envelopeLog.push(envelope);
      recorder?.envelope(type);
      if (type === "createSurface") this.surfaces.add((envelope as { createSurface: { surfaceId: string } }).createSurface.surfaceId);
      if (type === "deleteSurface") this.surfaces.delete((envelope as { deleteSurface: { surfaceId: string } }).deleteSurface.surfaceId);
      logger.debug("emit", { session: this.id, type, bytes: JSON.stringify(envelope).length });
      this.send("a2ui", envelope);
    }
  }

  /**
   * Starts over: drops the bill, UI state, model history and telemetry, tells clients to clear
   * (`chat {type:"reset"}`), deletes every live surface, then empties the envelope log so a
   * reconnect replays nothing. Same object, same id — SSE sinks keep their subscription.
   * Throws while a model turn is running (it would write its history back afterwards).
   */
  reset(): { deletedSurfaces: string[] } {
    if (this.busy) {
      logger.warn("reset refused: busy", { session: this.id });
      throw new Error("session busy");
    }
    const deletedSurfaces = [...this.surfaces];
    const before = { hadBill: Boolean(this.billId), messages: this.messages.length, envelopes: this.envelopeLog.length, turns: this.telemetry.length };

    this.store = new BillStore();
    this.billId = undefined;
    this.ui = {};
    this.lastVm = undefined;
    this.modelSeenVersion = 0;
    this.messages = [];
    this.telemetry = [];
    this.streamedRenders.clear();
    this.turnCounter = 0;
    this.recorder = undefined;
    logger.debug("reset: state cleared", { session: this.id, ...before });

    this.send("chat", { type: "reset" });
    this.emit(deletedSurfaces.map((id) => deleteSurface(id)), undefined);
    this.envelopeLog.length = 0;

    logger.info("reset", { session: this.id, deletedSurfaces, ...before });
    return { deletedSurfaces };
  }
}

export class SessionRegistry {
  private readonly sessions = new Map<string, Session>();

  get(id: string): Session {
    let session = this.sessions.get(id);
    if (!session) {
      session = new Session(id);
      this.sessions.set(id, session);
      logger.info("created", { session: id });
    }
    return session;
  }

  has(id: string): boolean {
    return this.sessions.has(id);
  }
}
