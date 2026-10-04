// Collects the TZ §7 evidence (per-turn telemetry, raw A2UI envelopes, renderer rejections) from
// app mount on, whether or not the debug drawer is open.
import { useEffect, useRef, useState } from "react";
import { subscribe, type TurnStatus } from "../a2ui/api";
import { onFeedError, type A2uiEnvelope, type FeedError } from "../a2ui/processor";
import { warn } from "./log";

export type LogEntry = { id: number; envelope: A2uiEnvelope; type: string; bytes: number; rejected: boolean };

const MAX_ENTRIES = 300;
const MAX_ERRORS = 20;
let nextId = 1;

export function envelopeType(e: A2uiEnvelope): string {
  return Object.keys(e).find((k) => k !== "version") ?? "?";
}

export interface DebugFeed {
  turns: TurnStatus[];
  entries: LogEntry[];
  renderErrors: FeedError[];
  clearErrors: () => void;
}

export function useDebugFeed(onRenderError?: (errors: FeedError[]) => void): DebugFeed {
  const [turns, setTurns] = useState<TurnStatus[]>([]);
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [renderErrors, setRenderErrors] = useState<FeedError[]>([]);
  const onRenderErrorRef = useRef(onRenderError);
  onRenderErrorRef.current = onRenderError;

  useEffect(
    () =>
      onFeedError((errors) => {
        for (const e of errors) warn("feed", "render rejected", { type: envelopeType(e.envelope), message: e.message });
        setRenderErrors((prev) => [...prev, ...errors].slice(-MAX_ERRORS));
        onRenderErrorRef.current?.(errors);
      }),
    [],
  );

  useEffect(
    () =>
      subscribe((event) => {
        if (event.kind === "status") {
          setTurns((prev) => [...prev.filter((t) => t.turn !== event.status.turn), event.status].sort((a, b) => a.turn - b.turn));
        } else if (event.kind === "a2ui") {
          const type = envelopeType(event.envelope);
          const entry = { id: nextId++, envelope: event.envelope, type, bytes: JSON.stringify(event.envelope).length, rejected: event.errors.length > 0 };
          setEntries((prev) => [...prev, entry].slice(-MAX_ENTRIES));
        }
      }),
    [],
  );

  return { turns, entries, renderErrors, clearErrors: () => setRenderErrors([]) };
}
