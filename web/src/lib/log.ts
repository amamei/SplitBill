// Tiny client logger. `debug`/`info` print only in debug mode (?debug=1 or the a2ui-debug pref,
// see lib/debugMode.ts); `warn`/`error` always print. Format: "[ui.<scope>] message", data.

let debugEnabled = false;

export function setLogDebug(on: boolean): void {
  debugEnabled = on;
}

export function isLogDebug(): boolean {
  return debugEnabled;
}

export function debug(scope: string, message: string, data?: unknown): void {
  if (debugEnabled) console.debug(`[ui.${scope}] ${message}`, ...(data === undefined ? [] : [data]));
}

export function info(scope: string, message: string, data?: unknown): void {
  if (debugEnabled) console.info(`[ui.${scope}] ${message}`, ...(data === undefined ? [] : [data]));
}

export function warn(scope: string, message: string, data?: unknown): void {
  console.warn(`[ui.${scope}] ${message}`, ...(data === undefined ? [] : [data]));
}

export function error(scope: string, message: string, data?: unknown): void {
  console.error(`[ui.${scope}] ${message}`, ...(data === undefined ? [] : [data]));
}
