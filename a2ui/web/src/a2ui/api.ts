// Browser ↔ server: one SSE stream per session (a2ui | chat | status | error) and JSON POSTs.
import type { ActionPayload } from "@a2ui/web_core/v0_9";
import { feed, onAction, rendererDataModel, type A2uiEnvelope, type FeedError } from "./processor";

export type ChatEvent =
  | { type: "delta"; turn: number; text: string }
  | { type: "done"; turn: number }
  | { type: "note"; text: string };

export interface TurnStatus {
  turn: number;
  kind: "chat" | "action" | "upload";
  action?: string;
  startedAt: string;
  firstA2uiMs: number | null;
  firstTextMs: number | null;
  totalMs: number;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
  iterations: number;
  messageCounts: { createSurface: number; updateComponents: number; updateDataModel: number; deleteSurface: number };
  validationRepairs: number;
  model: string;
  stopReason?: string | null;
  error?: string;
}

export type ServerEvent =
  | { kind: "a2ui"; envelope: A2uiEnvelope; errors: FeedError[] }
  | { kind: "chat"; event: ChatEvent }
  | { kind: "status"; status: TurnStatus }
  | { kind: "error"; message: string }
  | { kind: "connection"; open: boolean }
  | { kind: "forwarded"; name: string };

type Listener = (event: ServerEvent) => void;
const listeners = new Set<Listener>();

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function publish(event: ServerEvent): void {
  for (const l of listeners) l(event);
}

function newSessionId(): string {
  return crypto.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export const sessionId: string = (() => {
  try {
    const existing = sessionStorage.getItem("a2ui-session");
    if (existing) return existing;
    const id = newSessionId();
    sessionStorage.setItem("a2ui-session", id);
    return id;
  } catch {
    return newSessionId();
  }
})();

let source: EventSource | undefined;

/** Opens the SSE stream once (idempotent: StrictMode mounts effects twice). */
export function connect(): void {
  if (source) return;
  source = new EventSource(`/api/events?sessionId=${encodeURIComponent(sessionId)}`);
  source.onopen = () => {
    console.info("[sse] open", { sessionId });
    publish({ kind: "connection", open: true });
  };
  source.onerror = (e) => {
    console.warn("[sse] error / reconnecting", e);
    publish({ kind: "connection", open: false });
  };
  source.addEventListener("a2ui", (e) => {
    const envelope = JSON.parse((e as MessageEvent).data) as A2uiEnvelope;
    const errors = feed([envelope]);
    publish({ kind: "a2ui", envelope, errors });
  });
  source.addEventListener("chat", (e) => publish({ kind: "chat", event: JSON.parse((e as MessageEvent).data) }));
  source.addEventListener("status", (e) => publish({ kind: "status", status: JSON.parse((e as MessageEvent).data) }));
  source.addEventListener("error", (e) => {
    const data = (e as MessageEvent).data;
    if (typeof data === "string") publish({ kind: "error", message: JSON.parse(data).message });
  });
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const started = performance.now();
  const res = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const json = (await res.json().catch(() => ({}))) as T & { error?: { message: string } };
  console.info("[api]", path, { status: res.status, ms: Math.round(performance.now() - started) });
  if (!res.ok) throw new Error(json.error?.message ?? `HTTP ${res.status}`);
  return json;
}

export function postChat(text: string): Promise<{ accepted: boolean }> {
  return post("/api/chat", { sessionId, text });
}

export function postAction(action: ActionPayload, a2uiClientDataModel: Record<string, unknown> | undefined) {
  return post<{ handled: boolean; forwarded?: boolean }>("/api/action", { sessionId, version: "v0.9", action, a2uiClientDataModel });
}

export async function postUpload(file: File, text?: string): Promise<{ accepted: boolean }> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
  const dataBase64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  return post("/api/upload", { sessionId, mediaType: file.type, dataBase64, text });
}

// UI actions from every surface go to the server together with the client data model
// (spec a2uiClientDataModel); nothing in @a2ui/react does this for us.
const spikeMode = new URLSearchParams(location.search).has("spike");
onAction((action) => {
  if (spikeMode) return; // spike fixtures are local only
  postAction(action, rendererDataModel())
    .then((r) => r.forwarded && publish({ kind: "forwarded", name: action.name }))
    .catch((err: Error) => publish({ kind: "error", message: err.message }));
});
