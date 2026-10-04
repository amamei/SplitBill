import { useEffect, useRef } from "react";
import type { DebugFeed } from "../lib/debugFeed";
import { debug } from "../lib/log";
import { EnvelopeList, RenderErrors, TurnsTable } from "./MessageLog";

interface Props {
  open: boolean;
  feed: DebugFeed;
  onClose: () => void;
}

/** Developer drawer (right side on desktop, bottom sheet on phones). Closed by default. */
export function DebugDrawer({ open, feed, onClose }: Props) {
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    debug("debug", "drawer", { open });
    if (open) closeRef.current?.focus({ preventScroll: true });
  }, [open]);

  return (
    <aside id="debug-drawer" className={`drawer${open ? " is-open" : ""}`} role="dialog" aria-modal="false" aria-labelledby="debug-drawer-title" hidden={!open}>
      <header className="drawer-head">
        <h2 id="debug-drawer-title">Отладка</h2>
        <button ref={closeRef} type="button" className="ghost-button" onClick={onClose}>
          Закрыть
        </button>
      </header>
      <div className="drawer-body">
        <section>
          <h3>Замеры по ходам ({feed.turns.length})</h3>
          <TurnsTable turns={feed.turns} />
        </section>
        <section>
          <h3>Ошибки рендера ({feed.renderErrors.length})</h3>
          <RenderErrors errors={feed.renderErrors} onClear={feed.clearErrors} />
        </section>
        <section>
          <h3>Сообщения A2UI ({feed.entries.length})</h3>
          <EnvelopeList entries={feed.entries} />
        </section>
      </div>
    </aside>
  );
}
