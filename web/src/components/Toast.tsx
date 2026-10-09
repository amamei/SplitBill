import { useEffect } from "react";

export interface ToastMessage {
  id: number;
  text: string;
  actionLabel?: string;
  onAction?: () => void;
}

interface Props {
  toast: ToastMessage | null;
  onDismiss: () => void;
  timeoutMs?: number;
}

/** Single polite toast region; a new message replaces the previous one. */
export function Toast({ toast, onDismiss, timeoutMs = 6000 }: Props) {
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(onDismiss, timeoutMs);
    return () => clearTimeout(t);
  }, [toast, onDismiss, timeoutMs]);

  return (
    <div className="toast-region" role="status" aria-live="polite">
      {toast && (
        <div className="toast" key={toast.id}>
          <span>{toast.text}</span>
          {toast.actionLabel && toast.onAction && (
            <button type="button" className="ghost-button" onClick={toast.onAction}>
              {toast.actionLabel}
            </button>
          )}
          <button type="button" className="ghost-button" aria-label="Закрыть уведомление" onClick={onDismiss}>
            ✕
          </button>
        </div>
      )}
    </div>
  );
}
