import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { subscribe } from "../a2ui/api";
import { onAction, processor } from "../a2ui/processor";
import { tagSections } from "../lib/billSections";
import { debug } from "../lib/log";

/** Actions that open an item in the editor right away. */
const OPENS_EDITOR = new Set(["select_item", "fix_item"]);
const FOCUSABLE = "input:not([type=hidden]), button, textarea, select, [tabindex]:not([tabindex='-1'])";

const editorField = (path: string) => String(processor.getSurface("bill")?.dataModel.get(path) ?? "");

/**
 * Tags the bill's sections (`data-section` on each Card, for the layout in surface.css) and
 * shows the «Редактор позиции» Card as a dialog: closed by default, opened by «Открыть» or a
 * new item, closed after a clean save, Esc, the backdrop or the close button. The Card stays
 * where the agent rendered it; only its presentation changes, so bindings keep working.
 */
export function ItemEditorDialog({ body }: { body: HTMLElement | null }) {
  const [editor, setEditor] = useState<HTMLElement | null>(null);
  const [open, setOpen] = useState(false);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  // Re-tag whenever the agent's tree changes (it streams in, and a re-render may replace Cards).
  useEffect(() => {
    if (!body) return;
    const sync = () => setEditor(tagSections(body).get("editor") ?? null);
    sync();
    const mo = new MutationObserver(sync);
    mo.observe(body, { childList: true, subtree: true, characterData: true });
    return () => mo.disconnect();
  }, [body]);

  const show = useCallback((reason: string) => {
    debug("editor", "open", { reason });
    if (document.activeElement instanceof HTMLElement) returnFocusRef.current = document.activeElement;
    setOpen(true);
  }, []);
  const close = useCallback((reason: string) => {
    debug("editor", "close", { reason });
    setOpen(false);
  }, []);

  useEffect(() => {
    const offAction = onAction((action) => {
      if (action.surfaceId === "bill" && OPENS_EDITOR.has(action.name)) show(action.name);
    });
    // The server's data model patches arrive before it answers the POST, so the result is readable here.
    const offDone = subscribe((e) => {
      if (e.kind !== "actionDone" || e.surfaceId !== "bill") return;
      if (e.name === "add_item" && !editorField("/errors/general/message")) show("add_item");
      if (e.name === "save_item" && !editorField("/editor/error") && !editorField("/editor/remainingText")) close("saved");
    });
    return () => {
      offAction();
      offDone();
    };
  }, [show, close]);

  // Dialog semantics, scroll lock, focus in and back out.
  useEffect(() => {
    if (!body || !editor) return;
    if (!open) {
      body.removeAttribute("data-editor-open");
      editor.removeAttribute("role");
      editor.removeAttribute("aria-modal");
      return;
    }
    body.setAttribute("data-editor-open", "");
    editor.setAttribute("role", "dialog");
    editor.setAttribute("aria-modal", "true");
    const heading = editor.querySelector("h2, h3, h4");
    if (heading) {
      heading.id ||= "bill-editor-title";
      editor.setAttribute("aria-labelledby", heading.id);
    }
    document.documentElement.classList.add("sheet-open");
    const raf = requestAnimationFrame(() => editor.querySelector<HTMLElement>("input, textarea")?.focus());
    return () => {
      cancelAnimationFrame(raf);
      document.documentElement.classList.remove("sheet-open");
      const back = returnFocusRef.current;
      if (back?.isConnected) back.focus();
    };
  }, [open, body, editor]);

  // Esc closes; Tab stays inside the dialog.
  useEffect(() => {
    if (!open || !editor) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        close("escape");
        return;
      }
      if (e.key !== "Tab") return;
      const items = [...editor.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => !el.hasAttribute("disabled") && el.offsetParent !== null);
      if (items.length === 0) return;
      const first = items[0]!;
      const last = items.at(-1)!;
      if (e.shiftKey && (document.activeElement === first || !editor.contains(document.activeElement))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (document.activeElement === last || !editor.contains(document.activeElement))) {
        e.preventDefault();
        first.focus();
      }
    };
    addEventListener("keydown", onKeyDown, true);
    return () => removeEventListener("keydown", onKeyDown, true);
  }, [open, editor, close]);

  // The Card went away (new bill, re-render without an editor): nothing left to show.
  useEffect(() => {
    if (open && !editor) setOpen(false);
  }, [open, editor]);

  if (!open || !editor) return null;
  return (
    <>
      {createPortal(<div className="sheet-backdrop" onClick={() => close("backdrop")} aria-hidden="true" />, document.body)}
      {createPortal(
        <button type="button" className="sheet-close" onClick={() => close("button")} aria-label="Закрыть редактор">
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>,
        editor,
      )}
    </>
  );
}
