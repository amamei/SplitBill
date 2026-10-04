import { useEffect, useMemo, useRef, useState } from "react";
import { MarkdownContext, type ReactComponentImplementation } from "@a2ui/react/v0_9";
import type { SurfaceModel } from "@a2ui/web_core/v0_9";
import { renderMarkdown } from "@a2ui/markdown-it";
import { processor } from "../a2ui/processor";
import { debug } from "../lib/log";
import { orderSurfaces, surfaceTitle } from "../lib/surfaces";
import { useOutline } from "../lib/useOutline";
import { SurfaceFrame } from "./SurfaceFrame";
import { SurfaceNav } from "./SurfaceNav";

type Surface = SurfaceModel<ReactComponentImplementation>;

/** Surfaces created this soon after mount are SSE replays after a reload: no scroll/flash. */
const REPLAY_WINDOW_MS = 1500;

const toggle = (set: Set<string>, id: string) => {
  const next = new Set(set);
  if (!next.delete(id)) next.add(id);
  return next;
};

/** Renders every live surface (`bill` first) with a sticky switcher and section outline. */
export function Surfaces() {
  const [surfaces, setSurfaces] = useState<Surface[]>(() => [...processor.getSurfaces().values()]);
  const [hidden, setHidden] = useState<Set<string>>(() => new Set());
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [freshIds, setFreshIds] = useState<Set<string>>(() => new Set());
  const [currentId, setCurrentId] = useState<string>();
  const [bodies, setBodies] = useState<Record<string, HTMLDivElement | null>>({});
  const listRef = useRef<HTMLDivElement>(null);
  // One stable ref callback per surface; an inline callback would re-fire (and re-set state) every render.
  const bodyRefs = useRef(new Map<string, (el: HTMLDivElement | null) => void>());
  const bodyRefFor = (id: string) => {
    let cb = bodyRefs.current.get(id);
    if (!cb) {
      cb = (el) => setBodies((b) => (b[id] === el ? b : { ...b, [id]: el }));
      bodyRefs.current.set(id, cb);
    }
    return cb;
  };

  useEffect(() => {
    const mountedAt = performance.now();
    const known = new Set(processor.getSurfaces().keys());
    const sync = () => {
      const all = [...processor.getSurfaces().values()];
      const added = all.filter((s) => !known.has(s.id)).map((s) => s.id);
      for (const id of added) known.add(id);
      for (const id of [...known]) if (!processor.getSurface(id)) known.delete(id);
      const animate = added.filter((id) => id !== "bill" && performance.now() - mountedAt > REPLAY_WINDOW_MS);
      debug("surfaces", "sync", { ids: all.map((s) => s.id), added, animate });
      if (animate.length) {
        setFreshIds(new Set(animate));
        setCurrentId(animate.at(-1));
      }
      setSurfaces(all);
    };
    sync();
    const created = processor.onSurfaceCreated(sync);
    const deleted = processor.onSurfaceDeleted(sync);
    return () => {
      created.unsubscribe();
      deleted.unsubscribe();
    };
  }, []);

  const ordered = useMemo(() => orderSurfaces(surfaces), [surfaces]);
  const visible = ordered.filter((s) => !hidden.has(s.id));
  const current = visible.find((s) => s.id === currentId) ?? visible[0];

  // Follow the reader: the frame nearest the top of the viewport becomes current.
  useEffect(() => {
    const root = listRef.current;
    if (!root || visible.length < 2) return;
    const io = new IntersectionObserver(
      (entries) => {
        const top = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        const id = (top?.target as HTMLElement | undefined)?.dataset.surfaceId;
        if (id) setCurrentId(id);
      },
      { rootMargin: "-130px 0px -60% 0px" },
    );
    root.querySelectorAll(".surface-frame").forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [visible.map((s) => s.id).join("|")]);

  const outline = useOutline(current && !collapsed.has(current.id) ? (bodies[current.id] ?? null) : null, current?.id);

  if (ordered.length === 0) {
    return (
      <div className="empty-state">
        <svg viewBox="0 0 48 48" width="48" height="48" aria-hidden="true">
          <path d="M12 6h24v36l-6-4-6 4-6-4-6 4z" fill="var(--accent-soft)" stroke="var(--accent)" strokeWidth="2" strokeLinejoin="round" />
          <path d="M18 16h12M18 23h12M18 30h7" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" />
        </svg>
        <h2>Здесь появится счёт</h2>
        <p>Агент соберёт интерфейс счёта: участники, позиции, деление и итог — всё можно будет править прямо здесь.</p>
        <p className="empty-state-hint">Начните с сообщения в чате или выберите пример.</p>
      </div>
    );
  }

  return (
    <MarkdownContext.Provider value={renderMarkdown}>
      <SurfaceNav
        surfaces={visible.map((s) => ({ id: s.id, title: surfaceTitle(s.id, s.theme) }))}
        currentId={current?.id}
        hiddenCount={hidden.size}
        outline={outline.items}
        activeHeadingId={outline.activeId}
        onSelectSurface={setCurrentId}
        onShowHidden={() => setHidden(new Set())}
      />
      <div className="surface-list" ref={listRef}>
        {visible.map((s) => (
          <SurfaceFrame
            key={s.id}
            surface={s}
            collapsed={collapsed.has(s.id)}
            isNew={freshIds.has(s.id)}
            onToggleCollapsed={() => setCollapsed((c) => toggle(c, s.id))}
            onHide={() => {
              debug("surfaces", "hide", { surfaceId: s.id });
              setHidden((h) => new Set(h).add(s.id));
            }}
            bodyRef={bodyRefFor(s.id)}
          />
        ))}
      </div>
    </MarkdownContext.Provider>
  );
}
