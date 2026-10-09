// Debug mode = verbose console logging. The «Отладка» drawer button is always visible.
// Enabled by ?debug=1 (remembered) or the a2ui-debug pref; ?debug=0 turns it off again.
import { parseFlag, readPref, writePref } from "./prefs";

export function initialDebugMode(search: string): boolean {
  const param = new URLSearchParams(search).get("debug");
  const fromUrl = param == null ? undefined : parseFlag(param);
  if (fromUrl !== undefined) writePref("a2ui-debug", fromUrl ? "1" : "0");
  return fromUrl ?? readPref("a2ui-debug", false, parseFlag);
}
