import type { OutlineItem } from "../lib/useOutline";
import { debug } from "../lib/log";

interface Props {
  surfaces: Array<{ id: string; title: string }>;
  currentId: string | undefined;
  hiddenCount: number;
  outline: OutlineItem[];
  activeHeadingId: string | undefined;
  onSelectSurface: (id: string) => void;
  onShowHidden: () => void;
}

const reducedMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

function scrollToId(id: string) {
  const el = document.getElementById(id);
  if (!el) return;
  debug("nav", "jump", { id });
  el.scrollIntoView({ behavior: reducedMotion() ? "auto" : "smooth", block: "start" });
}

/** Sticky switcher between surfaces plus an outline of the current surface's sections. */
export function SurfaceNav({ surfaces, currentId, hiddenCount, outline, activeHeadingId, onSelectSurface, onShowHidden }: Props) {
  const showSwitcher = surfaces.length > 1 || hiddenCount > 0;
  const showOutline = outline.length >= 2;
  if (!showSwitcher && !showOutline) return null;
  return (
    <nav className="surface-nav" aria-label="Навигация по интерфейсу">
      {showSwitcher && (
        <div className="chip-row">
          {surfaces.map((s) => (
            <button
              key={s.id}
              type="button"
              className="chip"
              aria-current={s.id === currentId ? "true" : undefined}
              onClick={() => {
                onSelectSurface(s.id);
                scrollToId(`surface-${s.id}`);
              }}
            >
              {s.title}
            </button>
          ))}
          {hiddenCount > 0 && (
            <button type="button" className="chip chip--muted" onClick={onShowHidden}>
              Показать скрытые ({hiddenCount})
            </button>
          )}
        </div>
      )}
      {showOutline && (
        <div className="chip-row chip-row--outline" aria-label="Разделы">
          {outline.map((h) => (
            <a
              key={h.id}
              href={`#${h.id}`}
              className="outline-link"
              aria-current={h.id === activeHeadingId ? "true" : undefined}
              onClick={(e) => {
                e.preventDefault();
                scrollToId(h.id);
              }}
            >
              {h.text}
            </a>
          ))}
        </div>
      )}
    </nav>
  );
}
