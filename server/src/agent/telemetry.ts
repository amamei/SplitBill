// Per-turn measurements for TZ §7 ("Скорость и токены", "Обновление на месте", "Надёжность").
import type { A2uiEnvelopeType } from "../a2ui/envelopes.js";

export type MessageCounts = Record<A2uiEnvelopeType, number>;

export interface TurnTelemetry {
  turn: number;
  kind: "chat" | "action" | "upload";
  startedAt: string;
  firstA2uiMs: number | null;
  firstTextMs: number | null;
  totalMs: number;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
  iterations: number;
  messageCounts: MessageCounts;
  validationRepairs: number;
  promptVersion: string;
  model: string;
  stopReason?: string | null;
  error?: string;
}

export function emptyCounts(): MessageCounts {
  return { createSurface: 0, updateComponents: 0, updateDataModel: 0, deleteSurface: 0 };
}

/** Mutable accumulator for the turn in progress. */
export class TurnRecorder {
  readonly started = Date.now();
  readonly data: TurnTelemetry;

  constructor(turn: number, kind: TurnTelemetry["kind"], model: string, promptVersion: string) {
    this.data = {
      turn,
      kind,
      startedAt: new Date(this.started).toISOString(),
      firstA2uiMs: null,
      firstTextMs: null,
      totalMs: 0,
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      iterations: 0,
      messageCounts: emptyCounts(),
      validationRepairs: 0,
      promptVersion,
      model,
    };
  }

  envelope(type: A2uiEnvelopeType): void {
    if (this.data.firstA2uiMs === null) this.data.firstA2uiMs = Date.now() - this.started;
    this.data.messageCounts[type] += 1;
  }

  text(): void {
    if (this.data.firstTextMs === null) this.data.firstTextMs = Date.now() - this.started;
  }

  usage(u: { input_tokens?: number | null; output_tokens?: number | null; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null }): void {
    this.data.iterations += 1;
    this.data.tokens.input += u.input_tokens ?? 0;
    this.data.tokens.output += u.output_tokens ?? 0;
    this.data.tokens.cacheRead += u.cache_read_input_tokens ?? 0;
    this.data.tokens.cacheWrite += u.cache_creation_input_tokens ?? 0;
  }

  finish(): TurnTelemetry {
    this.data.totalMs = Date.now() - this.started;
    return this.data;
  }
}
