// Leveled stderr logger: `<ISO time> LEVEL [scope] message {json}`.
// Level comes from LOG_LEVEL (debug | info | warn | error), default info.
// It is read on every call so a late `process.loadEnvFile` still takes effect.

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const MAX_DATA_CHARS = 2048;

function currentLevel(): number {
  const raw = (process.env.LOG_LEVEL ?? "info").toLowerCase() as LogLevel;
  return LEVELS[raw] ?? LEVELS.info;
}

function serialize(data: unknown): string {
  if (data === undefined) return "";
  let text: string;
  if (data instanceof Error) {
    text = JSON.stringify({ name: data.name, message: data.message, stack: data.stack });
  } else {
    try {
      text = JSON.stringify(data);
    } catch {
      text = String(data);
    }
  }
  if (text.length > MAX_DATA_CHARS) {
    text = `${text.slice(0, MAX_DATA_CHARS)}…(truncated ${text.length - MAX_DATA_CHARS} chars)`;
  }
  return ` ${text}`;
}

function write(level: LogLevel, scope: string, message: string, data?: unknown): void {
  if (LEVELS[level] < currentLevel()) return;
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${scope}] ${message}${serialize(data)}\n`;
  process.stderr.write(line);
}

export const log = {
  debug: (scope: string, message: string, data?: unknown) => write("debug", scope, message, data),
  info: (scope: string, message: string, data?: unknown) => write("info", scope, message, data),
  warn: (scope: string, message: string, data?: unknown) => write("warn", scope, message, data),
  error: (scope: string, message: string, data?: unknown) => write("error", scope, message, data),
  isDebug: () => currentLevel() <= LEVELS.debug,
};

export type ScopedLogger = {
  debug: (message: string, data?: unknown) => void;
  info: (message: string, data?: unknown) => void;
  warn: (message: string, data?: unknown) => void;
  error: (message: string, data?: unknown) => void;
};

export function createScope(scope: string): ScopedLogger {
  return {
    debug: (message, data) => write("debug", scope, message, data),
    info: (message, data) => write("info", scope, message, data),
    warn: (message, data) => write("warn", scope, message, data),
    error: (message, data) => write("error", scope, message, data),
  };
}
