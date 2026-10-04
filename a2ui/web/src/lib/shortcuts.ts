// Global keyboard shortcuts, as a pure key → action mapping (wired in App.tsx).

export type ShortcutAction = "focusComposer" | "closeOverlays" | "toggleDebug" | "showChat" | "showBill";

export type ShortcutKey = Pick<KeyboardEvent, "key" | "code" | "ctrlKey" | "metaKey" | "shiftKey" | "altKey" | "isComposing">;

export function matchShortcut(e: ShortcutKey, targetIsEditable: boolean): ShortcutAction | null {
  if (e.isComposing) return null;
  if (e.key === "Escape") return "closeOverlays";
  const mod = e.ctrlKey || e.metaKey;
  // `code` keeps Ctrl/⌘+Shift+D and Alt+1/2 working on non-latin layouts and on macOS,
  // where Alt+digit produces a symbol in `key`.
  if (mod && e.shiftKey && !e.altKey && (e.code === "KeyD" || e.key.toLowerCase() === "d")) return "toggleDebug";
  if (e.altKey && !mod && !e.shiftKey) {
    if (e.code === "Digit1" || e.key === "1") return "showChat";
    if (e.code === "Digit2" || e.key === "2") return "showBill";
  }
  if (e.key === "/" && !mod && !e.altKey && !targetIsEditable) return "focusComposer";
  return null;
}

export function isEditableTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.tagName !== "string") return false;
  const tag = el.tagName.toLowerCase();
  return tag === "input" || tag === "textarea" || tag === "select" || el.isContentEditable === true;
}
