// Per-viewer UI preferences in localStorage. Storage may be missing or throw (private mode,
// blocked site data), so every access is guarded and falls back to the default.
import { warn } from "./log";

export type PrefKey = "a2ui-theme" | "a2ui-debug" | "a2ui-debug-open";

export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

let storageOverride: KeyValueStorage | null | undefined;
const warned = new Set<string>();

/** Test hook: `null` simulates "no storage", `undefined` restores the real localStorage. */
export function setPrefsStorage(storage: KeyValueStorage | null | undefined): void {
  storageOverride = storage;
  warned.clear();
}

function storage(): KeyValueStorage | null {
  if (storageOverride !== undefined) return storageOverride;
  return (globalThis as { localStorage?: KeyValueStorage }).localStorage ?? null;
}

function warnOnce(key: string, err: unknown): void {
  if (warned.has(key)) return;
  warned.add(key);
  warn("prefs", "storage unavailable", { key, err: err instanceof Error ? err.message : String(err) });
}

export function readPref<T>(key: PrefKey, fallback: T, parse: (raw: string) => T | undefined): T {
  try {
    const raw = storage()?.getItem(key);
    if (raw == null) return fallback;
    return parse(raw) ?? fallback;
  } catch (err) {
    warnOnce(key, err);
    return fallback;
  }
}

/** Returns false when the value could not be stored. */
export function writePref(key: PrefKey, value: string): boolean {
  try {
    const s = storage();
    if (!s) return false;
    s.setItem(key, value);
    return true;
  } catch (err) {
    warnOnce(key, err);
    return false;
  }
}

export const parseFlag = (raw: string): boolean | undefined => (raw === "1" ? true : raw === "0" ? false : undefined);
