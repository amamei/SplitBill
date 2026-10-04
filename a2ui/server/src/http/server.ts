import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import express, { type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { config, logConfig } from "../config.js";
import { createScope } from "../log.js";
import { dispatchAction } from "../agent/actions.js";
import { buildSystemPrompt, promptVersion } from "../agent/prompt.js";
import { runTurn, type UserContent } from "../agent/runner.js";
import type { Session } from "../agent/session.js";
import { TurnRecorder } from "../agent/telemetry.js";
import { envelopeType } from "../a2ui/envelopes.js";
import { renderSurface } from "../agent/tools.js";
import { buildControlExample } from "../domain/fixtures/control-example.js";
import { REFERENCE_BILL_TREE } from "../debug/reference-tree.js";
import { sessions } from "./sessions.js";
import { openEventStream } from "./sse.js";

const logger = createScope("http.server");
const here = path.dirname(fileURLToPath(import.meta.url));
// Built web client (vite build / build --watch). Served on the API origin so the app
// also works when the Vite dev server cannot run (project path containing "#").
const webDist = path.resolve(here, "../../../web/dist");

const SessionId = z.string().min(1).max(100);
const ChatBody = z.object({ sessionId: SessionId, text: z.string().min(1).max(20_000) });
const ActionBody = z.object({
  sessionId: SessionId,
  version: z.string().optional(),
  action: z.object({
    name: z.string().min(1),
    surfaceId: z.string().default("bill"),
    sourceComponentId: z.string().optional(),
    timestamp: z.string().optional(),
    context: z.record(z.unknown()).default({}),
  }),
  a2uiClientDataModel: z.object({ version: z.string().optional(), surfaces: z.record(z.unknown()).optional() }).optional(),
});
const UploadBody = z.object({
  sessionId: SessionId,
  mediaType: z.enum(["image/jpeg", "image/png", "image/webp", "image/gif"]),
  dataBase64: z.string().min(1),
  text: z.string().max(5_000).optional(),
});

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function parse<S extends z.ZodTypeAny>(schema: S, value: unknown): z.infer<S> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new HttpError(400, "BAD_REQUEST", result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  }
  return result.data;
}

/** Starts an agent turn in the background; the client follows it over SSE. */
function startTurn(session: Session, content: UserContent, kind: "chat" | "action" | "upload"): void {
  if (session.busy) throw new HttpError(409, "BUSY", "Агент ещё отвечает на предыдущее сообщение");
  runTurn(session, content, { kind }).catch((err) => logger.error("turn crashed", { session: session.id, err: err instanceof Error ? err.stack : String(err) }));
}

export function createApp(): express.Express {
  const app = express();
  app.use(express.json({ limit: "15mb" }));
  app.use((req, res, next) => {
    const started = Date.now();
    res.on("finish", () => {
      if (!req.path.startsWith("/api/") || req.path === "/api/events") return;
      const sessionId = (req.body as { sessionId?: string } | undefined)?.sessionId ?? req.query.sessionId;
      logger.info(`${req.method} ${req.path}`, { sessionId, status: res.statusCode, ms: Date.now() - started });
    });
    next();
  });

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true, model: config.model });
  });

  app.get("/api/events", (req, res) => {
    const sessionId = parse(SessionId, req.query.sessionId);
    openEventStream(req, res, sessions.get(sessionId));
  });

  app.post("/api/chat", (req, res) => {
    const body = parse(ChatBody, req.body);
    startTurn(sessions.get(body.sessionId), body.text, "chat");
    res.status(202).json({ accepted: true });
  });

  app.post("/api/action", (req, res) => {
    const body = parse(ActionBody, req.body);
    const session = sessions.get(body.sessionId);
    const recorder = new TurnRecorder(0, "action", config.model, promptVersion());
    const result = dispatchAction(session, body.action, body.a2uiClientDataModel);
    if (result.kind === "handled") {
      recorder.data.turn = ++session.turnCounter;
      session.emit(result.envelopes, recorder);
      const telemetry = recorder.finish();
      session.telemetry.push(telemetry);
      session.send("status", { ...telemetry, action: body.action.name });
      res.json({ handled: true, envelopes: result.envelopes.length });
      return;
    }
    session.send("chat", { type: "note", text: result.userMessage });
    startTurn(session, result.userMessage, "action");
    res.json({ handled: false, forwarded: true });
  });

  app.post("/api/upload", (req, res) => {
    const body = parse(UploadBody, req.body);
    const content: UserContent = [
      { type: "image", source: { type: "base64", media_type: body.mediaType, data: body.dataBase64 } },
      { type: "text", text: body.text ?? "Распознай позиции чека и создай счёт; спроси, кто платил, если не ясно." },
    ];
    startTurn(sessions.get(body.sessionId), content, "upload");
    res.status(202).json({ accepted: true });
  });

  app.get("/api/log", (req, res) => {
    const session = sessions.get(parse(SessionId, req.query.sessionId));
    const envelopeCounts: Record<string, number> = {};
    for (const e of session.envelopeLog) envelopeCounts[envelopeType(e)] = (envelopeCounts[envelopeType(e)] ?? 0) + 1;
    res.json({ telemetry: session.telemetry, envelopeCounts });
  });

  app.get("/api/debug/bill", (req, res) => {
    const sessionId = parse(SessionId, req.query.sessionId);
    const session = sessions.has(sessionId) ? sessions.get(sessionId) : undefined;
    if (!session?.billId) throw new HttpError(404, "NO_BILL", "В этой сессии ещё нет счёта");
    res.json({ bill: session.store.getBill(session.billId), summary: session.store.getSummary(session.billId), viewModel: session.lastVm ?? null });
  });

  if (config.debug) {
    // Test aid (A2UI_DEBUG=1): control example + hand-written reference tree, no model involved.
    app.post("/api/debug/seed", (req, res) => {
      const session = sessions.get(parse(z.object({ sessionId: SessionId }), req.body).sessionId);
      session.billId = buildControlExample(session.store).billId;
      session.ui = {};
      session.modelSeenVersion = 0;
      renderSurface(session, { surfaceId: "bill", components: REFERENCE_BILL_TREE });
      res.json({ seeded: true, billId: session.billId });
    });
  }

  app.use("/api", (_req, _res, next) => next(new HttpError(404, "NOT_FOUND", "Unknown API route")));

  app.use(express.static(webDist));
  app.use((req, res, next) => {
    if (req.method !== "GET" || req.path.startsWith("/api/")) return next();
    const index = path.join(webDist, "index.html");
    if (!fs.existsSync(index)) return next();
    res.sendFile(index);
  });

  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: { code: err.code, message: err.message } });
      return;
    }
    if ((err as { type?: string }).type === "entity.too.large") {
      res.status(413).json({ error: { code: "TOO_LARGE", message: "Слишком большой запрос" } });
      return;
    }
    logger.error("unhandled", { path: req.path, err: err instanceof Error ? err.stack : String(err) });
    res.status(500).json({ error: { code: "INTERNAL", message: "Внутренняя ошибка сервера" } });
  });
  return app;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  logConfig();
  buildSystemPrompt();
  createApp().listen(config.port, () => {
    logger.info("listening", { port: config.port, webDist: fs.existsSync(webDist) ? webDist : null });
  });
}
