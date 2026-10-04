import { useEffect, useState } from "react";
import { A2uiSurface, MarkdownContext, type ReactComponentImplementation } from "@a2ui/react/v0_9";
import type { SurfaceModel } from "@a2ui/web_core/v0_9";
import { renderMarkdown } from "@a2ui/markdown-it";
import { processor } from "../a2ui/processor";

type Surface = SurfaceModel<ReactComponentImplementation>;

/** Renders every live surface; the `bill` surface always comes first. */
export function Surfaces() {
  const [surfaces, setSurfaces] = useState<Surface[]>(() => [...processor.getSurfaces().values()]);

  useEffect(() => {
    const sync = () => setSurfaces([...processor.getSurfaces().values()]);
    sync();
    const created = processor.onSurfaceCreated(sync);
    const deleted = processor.onSurfaceDeleted(sync);
    return () => {
      created.unsubscribe();
      deleted.unsubscribe();
    };
  }, []);

  const ordered = [...surfaces].sort((a, b) => Number(b.id === "bill") - Number(a.id === "bill"));
  if (ordered.length === 0) {
    return <p className="surfaces-empty">Здесь появится интерфейс, который соберёт агент.</p>;
  }
  return (
    <MarkdownContext.Provider value={renderMarkdown}>
      {ordered.map((s) => (
        <section key={s.id} className="a2ui-root" data-surface-id={s.id}>
          <A2uiSurface surface={s} />
        </section>
      ))}
    </MarkdownContext.Provider>
  );
}
