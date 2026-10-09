export type Pane = "chat" | "bill";

interface Props {
  active: Pane;
  unseen: Record<Pane, boolean>;
  onChange: (pane: Pane) => void;
}

const TABS: Array<{ pane: Pane; label: string; icon: string }> = [
  { pane: "chat", label: "Чат", icon: "M4 5h16v11H9l-5 4z" },
  { pane: "bill", label: "Счёт", icon: "M6 3h12v18l-3-2-3 2-3-2-3 2zM9 8h6M9 12h6" },
];

/** Bottom tab bar for phone widths: one pane visible at a time. */
export function MobileTabBar({ active, unseen, onChange }: Props) {
  return (
    <nav className="tabbar" role="tablist" aria-label="Разделы">
      {TABS.map((t) => (
        <button
          key={t.pane}
          type="button"
          role="tab"
          id={`tab-${t.pane}`}
          aria-selected={active === t.pane}
          aria-controls={`pane-${t.pane}`}
          onClick={() => onChange(t.pane)}
        >
          <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
            <path d={t.icon} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" strokeLinecap="round" />
          </svg>
          <span>{t.label}</span>
          {unseen[t.pane] && active !== t.pane && (
            <span className="tab-dot">
              <span className="visually-hidden">есть обновления</span>
            </span>
          )}
        </button>
      ))}
    </nav>
  );
}
