// Bridges streamed render_surface tool input to the client: createSurface as soon as the
// surface id is known, then updateComponents batches (every 8 components or 150 ms).
// render_surface's run() validates the full tree afterwards: it sends the rest + data,
// or deletes the half-built surface and returns the errors to the model.
import { createScope } from "../log.js";
import { ComponentStreamExtractor } from "../a2ui/stream-extract.js";
import { createSurface, deleteSurface, updateComponents, type A2uiComponent, type A2uiEnvelope } from "../a2ui/envelopes.js";
import type { Session } from "./session.js";

const logger = createScope("a2ui.stream");
const FLUSH_EVERY = 8;
const FLUSH_MS = 150;

export interface RenderStreamer {
  start(index: number, toolUseId: string, name: string): void;
  delta(index: number, partialJson: string): void;
  stop(index: number): void;
  /** Deletes surfaces whose render_surface call never completed (refusal, truncation, retry). */
  abortAll(): void;
}

interface Active {
  toolUseId: string;
  extractor: ComponentStreamExtractor;
  surfaceId?: string;
  pending: A2uiComponent[];
  timer?: NodeJS.Timeout;
  total: number;
}

export function createRenderStreamer(session: Session, opts: { enabled: boolean }): RenderStreamer {
  const active = new Map<number, Active>();
  const started = new Set<string>();

  const flush = (a: Active) => {
    if (a.timer) clearTimeout(a.timer);
    a.timer = undefined;
    const entry = session.streamedRenders.get(a.toolUseId);
    if (!a.surfaceId || !entry || a.pending.length === 0) return;
    const batch = a.pending.splice(0);
    entry.sent += batch.length;
    a.total += batch.length;
    logger.debug("flush", { surfaceId: a.surfaceId, n: batch.length, totalSoFar: a.total });
    session.emit([updateComponents(a.surfaceId, batch)]);
  };

  return {
    start(index, toolUseId, name) {
      if (!opts.enabled || name !== "render_surface") return;
      const a: Active = { toolUseId, pending: [], total: 0, extractor: undefined as unknown as ComponentStreamExtractor };
      a.extractor = new ComponentStreamExtractor({
        onSurfaceId: (surfaceId) => {
          // The bill surface needs a bill; without one the tool call will fail anyway.
          if (surfaceId === "bill" && !session.billId) return;
          a.surfaceId = surfaceId;
          const envelopes: A2uiEnvelope[] = [];
          if (session.surfaces.has(surfaceId)) envelopes.push(deleteSurface(surfaceId));
          envelopes.push(createSurface(surfaceId, { sendDataModel: true }));
          session.streamedRenders.set(toolUseId, { surfaceId, sent: 0 });
          started.add(toolUseId);
          session.emit(envelopes);
          if (a.pending.length > 0) flush(a); // components that arrived before the id
        },
        onComponent: (component) => {
          a.pending.push(component as A2uiComponent);
          if (!a.surfaceId) return;
          if (a.pending.length >= FLUSH_EVERY) flush(a);
          else a.timer ??= setTimeout(() => flush(a), FLUSH_MS);
        },
      });
      active.set(index, a);
    },

    delta(index, partialJson) {
      const a = active.get(index);
      if (!a) return;
      try {
        a.extractor.feed(partialJson);
      } catch (err) {
        logger.warn("extractor failed; falling back to render on completion", { err: String(err) });
        if (a.timer) clearTimeout(a.timer);
        active.delete(index);
      }
    },

    stop(index) {
      const a = active.get(index);
      if (!a) return;
      flush(a);
      active.delete(index);
    },

    abortAll() {
      for (const a of active.values()) if (a.timer) clearTimeout(a.timer);
      active.clear();
      for (const toolUseId of started) {
        const entry = session.streamedRenders.get(toolUseId);
        if (!entry) continue; // consumed by render_surface
        session.streamedRenders.delete(toolUseId);
        logger.warn("dropping unfinished streamed surface", { surfaceId: entry.surfaceId });
        session.emit([deleteSurface(entry.surfaceId)]);
      }
      started.clear();
    },
  };
}
