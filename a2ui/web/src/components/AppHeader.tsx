import { useActivity } from "../lib/useServerState";
import { ConnectionStatus } from "./ConnectionStatus";
import { ThemeToggle } from "./ThemeToggle";

interface Props {
  subtitle?: string;
  offline?: boolean;
  debugEnabled: boolean;
  debugOpen: boolean;
  debugErrors: number;
  onToggleDebug: () => void;
}

/** Sticky top bar: brand, connection state, activity bar, theme and debug controls. */
export function AppHeader({ subtitle = "A2UI v0.9", offline, debugEnabled, debugOpen, debugErrors, onToggleDebug }: Props) {
  const { pending, agentBusy } = useActivity();
  const working = pending > 0 || agentBusy;
  return (
    <header className="app-header">
      <div className="app-header-inner">
        <div className="brand">
          <svg className="brand-mark" viewBox="0 0 32 32" width="26" height="26" aria-hidden="true">
            <circle cx="16" cy="16" r="14" fill="var(--accent)" />
            <path d="M16 2v28" stroke="var(--page-bg)" strokeWidth="3" />
            <circle cx="16" cy="16" r="7" fill="none" stroke="var(--page-bg)" strokeWidth="2.5" />
          </svg>
          <span className="brand-name">Split Bill</span>
          <span className="brand-sub">{subtitle}</span>
        </div>
        <ConnectionStatus offline={offline} />
        <div className="header-actions">
          <ThemeToggle />
          {debugEnabled && (
            <button
              type="button"
              id="debug-toggle"
              className="header-button"
              aria-pressed={debugOpen}
              aria-controls="debug-drawer"
              onClick={onToggleDebug}
              title="Отладка (Ctrl/⌘+Shift+D)"
            >
              Отладка
              {debugErrors > 0 && (
                <span className="count-badge" aria-label={`ошибок рендера: ${debugErrors}`}>
                  {debugErrors}
                </span>
              )}
            </button>
          )}
        </div>
      </div>
      <div className={`activity-bar${working ? " is-active" : ""}`} role="progressbar" aria-label="Выполняется запрос" aria-hidden={!working} />
    </header>
  );
}
