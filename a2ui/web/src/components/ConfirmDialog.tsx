import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { debug } from "../lib/log";

interface Props {
  open: boolean;
  title: string;
  text: string;
  confirmLabel: string;
  cancelLabel?: string;
  danger?: boolean;
  /** May be async: the confirm button stays disabled until it settles (no double submit). */
  onConfirm: () => void | Promise<void>;
  onCancel: () => void;
}

/** Modal yes/no question. Cancel is focused first; Tab cycles between the two buttons. */
export function ConfirmDialog({ open, title, text, confirmLabel, cancelLabel = "Отмена", danger, onConfirm, onCancel }: Props) {
  const titleId = useId();
  const textId = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (!open) return;
    debug("app", "confirm dialog open", { title });
    const trigger = document.activeElement as HTMLElement | null;
    const dialog = cancelRef.current?.closest(".confirm-dialog");
    cancelRef.current?.focus();
    return () => {
      // Give focus back to the trigger unless the caller already moved it (e.g. to the composer).
      const active = document.activeElement;
      if (!active || active === document.body || dialog?.contains(active)) trigger?.focus?.({ preventScroll: true });
    };
  }, [open, title]);

  if (!open) return null;

  const confirm = async () => {
    setPending(true);
    try {
      await onConfirm();
    } finally {
      setPending(false);
    }
  };

  const trapTab = (e: KeyboardEvent) => {
    if (e.key !== "Tab") return;
    e.preventDefault();
    const next = document.activeElement === cancelRef.current ? confirmRef.current : cancelRef.current;
    next?.focus();
  };

  return (
    <div className="confirm-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={textId} onKeyDown={trapTab}>
        <h2 id={titleId}>{title}</h2>
        <p id={textId}>{text}</p>
        <div className="confirm-actions">
          <button type="button" ref={cancelRef} className="header-button" onClick={onCancel}>
            {cancelLabel}
          </button>
          <button
            type="button"
            ref={confirmRef}
            className={`header-button${danger ? " confirm-danger" : ""}`}
            onClick={confirm}
            disabled={pending}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
