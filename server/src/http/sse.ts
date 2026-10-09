// Server-sent events per session: a2ui | chat | status | error. On connect the session's
// envelope log is replayed so a page reload rebuilds every surface (the client skips a
// repeated createSurface for a live surface).
import type { Request, Response } from "express";
import { createScope } from "../log.js";
import type { Session, SseEventName } from "../agent/session.js";

const logger = createScope("http.sse");
const HEARTBEAT_MS = 15_000;

function write(res: Response, event: SseEventName, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

export function openEventStream(req: Request, res: Response, session: Session): void {
  res.status(200).set({
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders();
  res.write(": connected\n\n");

  for (const envelope of session.envelopeLog) write(res, "a2ui", envelope);
  for (const telemetry of session.telemetry) write(res, "status", telemetry);
  logger.debug("connect", { session: session.id, replayedEnvelopes: session.envelopeLog.length, turns: session.telemetry.length });

  const unsubscribe = session.subscribe((event, data) => write(res, event, data));
  const heartbeat = setInterval(() => res.write(": ping\n\n"), HEARTBEAT_MS);
  req.on("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
    logger.debug("disconnect", { session: session.id });
  });
}
