import type { ConnectionState } from "../a2ui/api";
import { useConnectionState } from "../lib/useServerState";

const LABELS: Record<ConnectionState, string> = {
  connecting: "Подключение…",
  open: "В сети",
  reconnecting: "Переподключение…",
  closed: "Нет связи",
};

/** Connection pill: dot + words, announced politely when it changes. */
export function ConnectionStatus({ offline = false }: { offline?: boolean }) {
  const state = useConnectionState();
  const shown: ConnectionState | "local" = offline ? "local" : state;
  return (
    <span className={`conn conn-${shown}`} role="status" aria-live="polite">
      <span className="conn-dot" aria-hidden="true" />
      {shown === "local" ? "Локально" : LABELS[shown]}
    </span>
  );
}
