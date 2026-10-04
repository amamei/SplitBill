// Light / dark / system theme. The resolved theme drives `data-theme` on <html> (our tokens) and
// `.a2ui-light` / `.a2ui-dark` (the renderer's default token sheet).
import { debug } from "./log";
import { readPref, writePref } from "./prefs";

export type ThemePref = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

export const THEME_COLORS: Record<ResolvedTheme, string> = { light: "#f4f2ee", dark: "#151413" };
const DARK_QUERY = "(prefers-color-scheme: dark)";

export function parseThemePref(raw: string): ThemePref | undefined {
  return raw === "system" || raw === "light" || raw === "dark" ? raw : undefined;
}

export function resolveTheme(pref: ThemePref, systemDark: boolean): ResolvedTheme {
  if (pref === "system") return systemDark ? "dark" : "light";
  return pref;
}

export function readThemePref(): ThemePref {
  return readPref("a2ui-theme", "system", parseThemePref);
}

export function saveThemePref(pref: ThemePref): void {
  writePref("a2ui-theme", pref);
}

function systemPrefersDark(): boolean {
  return typeof matchMedia === "function" && matchMedia(DARK_QUERY).matches;
}

export function applyTheme(pref: ThemePref): ResolvedTheme {
  const resolved = resolveTheme(pref, systemPrefersDark());
  const root = document.documentElement;
  if (pref === "system") delete root.dataset.theme;
  else root.dataset.theme = pref;
  root.classList.toggle("a2ui-dark", resolved === "dark");
  root.classList.toggle("a2ui-light", resolved === "light");
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", THEME_COLORS[resolved]);
  debug("theme", "applied", { pref, resolved });
  return resolved;
}

/** Calls `cb` when the OS theme changes; returns an unsubscribe function. */
export function watchSystemTheme(cb: () => void): () => void {
  if (typeof matchMedia !== "function") return () => {};
  const mq = matchMedia(DARK_QUERY);
  mq.addEventListener("change", cb);
  return () => mq.removeEventListener("change", cb);
}
