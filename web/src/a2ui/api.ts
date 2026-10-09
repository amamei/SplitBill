// Browser ↔ server: one SSE stream per session (a2ui | chat | status | error) and JSON POSTs.
import type { ActionPayload } from "@a2ui/web_core/v0_9";
import { debug, info, warn } from "../lib/log";
import { feed, onAction, rendererDataModel, type A2uiEnvelope, type FeedError } from "./processor";

export type ChatEvent =
  | { type: "delta"; turn: number; text: string }
  | { type: "done"; turn: number }
  | { type: "note"; text: string }
  /** Session wiped server-side ("Новый счёт"); deleteSurface envelopes follow. */
  | { type: "reset" };

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

export type ConnectionState = "connecting" | "open" | "reconnecting" | "closed";

/** In-flight HTTP requests and whether the agent (model turn) is working. */
export interface Activity {
  pending: number;
  agentBusy: boolean;
}

export type ServerEvent =
  | { kind: "a2ui"; envelope: A2uiEnvelope; errors: FeedError[] }
  | { kind: "chat"; event: ChatEvent }
  | { kind: "status"; status: TurnStatus }
  | { kind: "error"; message: string }
  | { kind: "connection"; state: ConnectionState }
  | { kind: "activity"; activity: Activity }
  | { kind: "forwarded"; name: string }
  /** The server finished a UI action it handles itself; its data model patches came first. */
  | { kind: "actionDone"; name: string; surfaceId: string };

type Listener = (event: ServerEvent) => void;
const listeners = new Set<Listener>();

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function publish(event: ServerEvent): void {
  for (const l of listeners) l(event);
}

// ---- connection + activity state (read by the header, chat and tab bar) ----

let connection: ConnectionState = "connecting";
let activity: Activity = { pending: 0, agentBusy: false };

export function getConnectionState(): ConnectionState {
  return connection;
}

export function getActivity(): Activity {
  return activity;
}

function setConnection(state: ConnectionState): void {
  if (state === connection) return;
  info("conn", `${connection} → ${state}`);
  connection = state;
  publish({ kind: "connection", state });
}

function setActivity(patch: Partial<Activity>): void {
  const next = { ...activity, ...patch };
  if (next.pending === activity.pending && next.agentBusy === activity.agentBusy) return;
  debug("activity", "changed", next);
  activity = next;
  publish({ kind: "activity", activity });
}

// ---- session + SSE ----

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
  const es = new EventSource(`/api/events?sessionId=${encodeURIComponent(sessionId)}`);
  source = es;
  es.onopen = () => {
    info("sse", "open", { sessionId });
    setConnection("open");
  };
  es.onerror = () => {
    // EventSource retries by itself while readyState is CONNECTING; CLOSED means it gave up.
    const state = es.readyState === EventSource.CLOSED ? "closed" : "reconnecting";
    warn("sse", "error", { state });
    setConnection(state);
    // A turn that was running when the stream dropped will never report "done" to us.
    if (activity.agentBusy) setActivity({ agentBusy: false });
  };
  es.addEventListener("a2ui", (e) => {
    const envelope = JSON.parse((e as MessageEvent).data) as A2uiEnvelope;
    const errors = feed([envelope]);
    publish({ kind: "a2ui", envelope, errors });
  });
  es.addEventListener("chat", (e) => {
    const event = JSON.parse((e as MessageEvent).data) as ChatEvent;
    if (event.type === "note") setActivity({ agentBusy: true });
    else if (event.type === "done") setActivity({ agentBusy: false });
    else if (event.type === "reset") {
      info("sse", "reset event");
      setActivity({ agentBusy: false });
    }
    publish({ kind: "chat", event });
  });
  es.addEventListener("status", (e) => publish({ kind: "status", status: JSON.parse((e as MessageEvent).data) }));
  es.addEventListener("error", (e) => {
    const data = (e as MessageEvent).data;
    if (typeof data === "string") publish({ kind: "error", message: JSON.parse(data).message });
  });
}

// ---- HTTP ----

async function post<T>(path: string, body: unknown): Promise<T> {
  const started = performance.now();
  setActivity({ pending: activity.pending + 1 });
  debug("api", "request start", { path });
  try {
    const res = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const json = (await res.json().catch(() => ({}))) as T & { error?: { message: string } };
    debug("api", "request end", { path, status: res.status, ms: Math.round(performance.now() - started) });
    if (!res.ok) throw new Error(json.error?.message ?? `HTTP ${res.status}`);
    return json;
  } finally {
    setActivity({ pending: Math.max(0, activity.pending - 1) });
  }
}

/** Starts a model turn; the agent stays busy until the server sends chat `done`. */
async function startTurn<T>(request: () => Promise<T>): Promise<T> {
  setActivity({ agentBusy: true });
  try {
    return await request();
  } catch (err) {
    setActivity({ agentBusy: false });
    throw err;
  }
}

export function postChat(text: string): Promise<{ accepted: boolean }> {
  return startTurn(() => post("/api/chat", { sessionId, text }));
}

export function postAction(action: ActionPayload, a2uiClientDataModel: Record<string, unknown> | undefined) {
  return post<{ handled: boolean; forwarded?: boolean }>("/api/action", { sessionId, version: "v0.9", action, a2uiClientDataModel });
}

/** "Новый счёт": wipes the session on the server (409 while the agent answers). Not a model turn. */
export async function postReset(): Promise<{ reset: boolean; deletedSurfaces: number }> {
  info("api", "reset requested", { sessionId });
  try {
    const result = await post<{ reset: boolean; deletedSurfaces: number }>("/api/reset", { sessionId });
    info("api", "reset done", { deletedSurfaces: result.deletedSurfaces });
    return result;
  } catch (err) {
    warn("api", "reset failed", { message: err instanceof Error ? err.message : String(err) });
    throw err;
  }
}

export async function postUpload(file: File, text?: string): Promise<{ accepted: boolean }> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
  const dataBase64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  return startTurn(() => post("/api/upload", { sessionId, mediaType: file.type, dataBase64, text }));
}

// UI actions from every surface go to the server together with the client data model
// (spec a2uiClientDataModel); nothing in @a2ui/react does this for us.
const spikeMode = new URLSearchParams(location.search).has("spike");
onAction((action) => {
  if (spikeMode) return; // spike fixtures are local only
  postAction(action, rendererDataModel())
    .then((r) => {
      if (r.handled) publish({ kind: "actionDone", name: action.name, surfaceId: action.surfaceId });
      if (!r.forwarded) return;
      setActivity({ agentBusy: true });
      publish({ kind: "forwarded", name: action.name });
    })
    .catch((err: Error) => publish({ kind: "error", message: err.message }));
});
