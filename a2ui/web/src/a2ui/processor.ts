// Single A2UI v0.9 MessageProcessor for the whole page.
// `feed()` is the only way server envelopes reach the renderer; UI actions fan out to
// listeners registered with `onAction()` (the API layer posts them to the server).
import { MessageProcessor, type ActionPayload } from "@a2ui/web_core/v0_9";
import type { ReactComponentImplementation } from "@a2ui/react/v0_9";
import { appCatalog } from "./catalog";

export type A2uiEnvelope = { version: string } & Record<string, unknown>;
export type FeedError = { message: string; envelope: A2uiEnvelope };
type ActionListener = (action: ActionPayload) => void;
type FeedErrorListener = (errors: FeedError[]) => void;

const actionListeners = new Set<ActionListener>();
const feedErrorListeners = new Set<FeedErrorListener>();

export const processor = new MessageProcessor<ReactComponentImplementation>([appCatalog], (action) => {
  console.info("[a2ui.action]", action);
  for (const listener of actionListeners) listener(action);
});

export function onAction(listener: ActionListener): () => void {
  actionListeners.add(listener);
  return () => actionListeners.delete(listener);
}

/** Renderer rejections from every `feed()` call (SSE and spike fixtures alike). */
export function onFeedError(listener: FeedErrorListener): () => void {
  feedErrorListeners.add(listener);
  return () => feedErrorListeners.delete(listener);
}

function envelopeType(envelope: A2uiEnvelope): string {
  return Object.keys(envelope).find((k) => k !== "version") ?? "unknown";
}

/**
 * Applies envelopes one by one so a single bad message does not drop the rest.
 * A repeated `createSurface` for an existing surface (SSE replay after reload) is skipped:
 * the processor would throw "already exists".
 */
export function feed(envelopes: readonly A2uiEnvelope[]): FeedError[] {
  console.debug("[a2ui.processor] feed", { count: envelopes.length, types: envelopes.map(envelopeType) });
  const errors: FeedError[] = [];
  for (const envelope of envelopes) {
    const create = envelope.createSurface as { surfaceId?: string } | undefined;
    if (create?.surfaceId && processor.getSurface(create.surfaceId)) {
      console.debug("[a2ui.processor] skip duplicate createSurface", create.surfaceId);
      continue;
    }
    try {
      processor.processMessages(envelope as never);
    } catch (err) {
      const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      console.error("[a2ui.processor] rejected", err, envelope);
      errors.push({ message, envelope });
    }
  }
  if (errors.length > 0) for (const l of feedErrorListeners) l(errors);
  return errors;
}

/** Data models of surfaces created with `sendDataModel: true` (spec `a2uiClientDataModel`). */
export function rendererDataModel(): Record<string, unknown> | undefined {
  try {
    return processor.getRendererDataModel("v0.9");
  } catch (err) {
    console.warn("[a2ui.processor] getRendererDataModel failed", err);
    return undefined;
  }
}
