import { useEffect, useRef, type CSSProperties } from "react";
import { A2uiSurface, type ReactComponentImplementation } from "@a2ui/react/v0_9";
import type { SurfaceModel } from "@a2ui/web_core/v0_9";
import { subscribe } from "../a2ui/api";
import { debug } from "../lib/log";
import { safeAccent, surfaceTitle } from "../lib/surfaces";

type Surface = SurfaceModel<ReactComponentImplementation>;

interface Props {
  surface: Surface;
  collapsed: boolean;
  isNew: boolean;
  onToggleCollapsed: () => void;
  onHide: () => void;
  bodyRef?: (el: HTMLDivElement | null) => void;
}

const reducedMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Titled container for one A2UI surface; extra surfaces can be collapsed or hidden locally. */
export function SurfaceFrame({ surface, collapsed, isNew, onToggleCollapsed, onHide, bodyRef }: Props) {
  const frameRef = useRef<HTMLElement>(null);
  const isBill = surface.id === "bill";
  const title = surfaceTitle(surface.id, surface.theme);
  const accent = safeAccent(surface.theme);
  const titleId = `surface-title-${surface.id}`;

  useEffect(() => {
    if (!isNew || !frameRef.current) return;
    debug("nav", "new surface", { surfaceId: surface.id });
    const el = frameRef.current;
    const align = () => el.scrollIntoView({ behavior: reducedMotion() ? "auto" : "smooth", block: "start" });
    align();
    el.classList.add("is-flashing");
    const t = setTimeout(() => el.classList.remove("is-flashing"), 1200);
    // The surface is created empty and streams in: the first scroll stops at the page bottom.
    // Keep re-aligning while it grows — until the agent's turn ends (max 20 s) or the reader
    // scrolls/types.
    let follow = true;
    const stop = () => (follow = false);
    const ro = new ResizeObserver(() => follow && align());
    ro.observe(el);
    const settle = setTimeout(stop, 20_000);
    const unsubscribe = subscribe((e) => {
      if (e.kind !== "activity" || e.activity.agentBusy || !follow) return;
      requestAnimationFrame(align);
      stop();
    });
    addEventListener("wheel", stop, { passive: true });
    addEventListener("touchstart", stop, { passive: true });
    addEventListener("keydown", stop);
    return () => {
      clearTimeout(t);
      clearTimeout(settle);
      ro.disconnect();
      unsubscribe();
      removeEventListener("wheel", stop);
      removeEventListener("touchstart", stop);
      removeEventListener("keydown", stop);
    };
  }, [isNew, surface.id]);

  const style = accent ? ({ "--surface-accent": accent } as CSSProperties) : undefined;

  return (
    <section
      ref={frameRef}
      className={`surface-frame${isBill ? " surface-frame--bill" : ""}`}
      id={`surface-${surface.id}`}
      data-surface-id={surface.id}
      data-accent={accent ? "" : undefined}
      aria-labelledby={titleId}
      style={style}
    >
      <header className="surface-frame-head">
        <h2 id={titleId}>{title}</h2>
        {!isBill && (
          <div className="surface-frame-actions">
            <button type="button" className="ghost-button" aria-expanded={!collapsed} aria-controls={`surface-body-${surface.id}`} onClick={onToggleCollapsed}>
              {collapsed ? "Развернуть" : "Свернуть"}
            </button>
            <button type="button" className="ghost-button" onClick={onHide}>
              Скрыть
            </button>
          </div>
        )}
      </header>
      <div className="a2ui-root surface-body" id={`surface-body-${surface.id}`} ref={bodyRef} hidden={collapsed}>
        <A2uiSurface surface={surface} />
      </div>
    </section>
  );
}
