import { SessionRegistry } from "../agent/session.js";

/** Process-wide in-memory sessions (TZ §3: no DB). */
export const sessions = new SessionRegistry();
