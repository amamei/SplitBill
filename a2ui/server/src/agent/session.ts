// Per-browser-session state: one bill, UI selection, the last data model pushed to the
// client, the model conversation, and the A2UI envelope log (replayed on SSE reconnect).
import type { BetaMessageParam } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { createScope } from "../log.js";
import { envelopeType, type A2uiEnvelope } from "../a2ui/envelopes.js";
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
  readonly store = new BillStore();
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
