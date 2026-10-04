import { useEffect, useState, type KeyboardEvent } from "react";
import { applyTheme, readThemePref, saveThemePref, watchSystemTheme, type ThemePref } from "../lib/theme";

const OPTIONS: Array<{ value: ThemePref; label: string; icon: string }> = [
  { value: "system", label: "Системная тема", icon: "M4 5h16v11H4zM9 19h6" },
  { value: "light", label: "Светлая тема", icon: "M12 4v2M12 18v2M4 12h2M18 12h2M6.3 6.3l1.4 1.4M16.3 16.3l1.4 1.4M6.3 17.7l1.4-1.4M16.3 7.7l1.4-1.4M12 8.5a3.5 3.5 0 1 0 0 7a3.5 3.5 0 1 0 0-7" },
  { value: "dark", label: "Тёмная тема", icon: "M19 14.5A7.5 7.5 0 0 1 9.5 5a7.5 7.5 0 1 0 9.5 9.5z" },
];

/** Segmented "system / light / dark" switch; the choice is remembered per browser. */
export function ThemeToggle() {
  const [pref, setPref] = useState<ThemePref>(readThemePref);

  useEffect(() => {
    applyTheme(pref);
    if (pref !== "system") return;
    return watchSystemTheme(() => applyTheme("system"));
  }, [pref]);

  function choose(value: ThemePref) {
    setPref(value);
    saveThemePref(value);
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    e.preventDefault();
    const i = OPTIONS.findIndex((o) => o.value === pref);
    const next = OPTIONS[(i + (e.key === "ArrowRight" ? 1 : OPTIONS.length - 1)) % OPTIONS.length]!;
    choose(next.value);
    e.currentTarget.querySelector<HTMLButtonElement>(`[data-value="${next.value}"]`)?.focus();
  }

  return (
    <div className="segmented" role="radiogroup" aria-label="Тема оформления" onKeyDown={onKeyDown}>
      {OPTIONS.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          data-value={o.value}
          aria-checked={pref === o.value}
          tabIndex={pref === o.value ? 0 : -1}
          title={o.label}
          onClick={() => choose(o.value)}
        >
          <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
            <path d={o.icon} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span className="visually-hidden">{o.label}</span>
        </button>
      ))}
    </div>
  );
}
