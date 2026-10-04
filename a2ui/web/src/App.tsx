import { useCallback, useEffect, useRef, useState } from "react";
import { connect, subscribe } from "./a2ui/api";
import { feed, onAction, processor, rendererDataModel, type FeedError } from "./a2ui/processor";
import { AppHeader } from "./components/AppHeader";
import { Chat } from "./components/Chat";
import { DebugDrawer } from "./components/DebugDrawer";
import { MobileTabBar, type Pane } from "./components/MobileTabBar";
import { Surfaces } from "./components/Surfaces";
import { Toast, type ToastMessage } from "./components/Toast";
import { spikeFixtures } from "./fixtures/spike";
import { useDebugFeed } from "./lib/debugFeed";
import { setDebugMode } from "./lib/debugMode";
import { debug, info, isLogDebug } from "./lib/log";
import { MOBILE_QUERY, useMediaQuery } from "./lib/media";
import { parseFlag, readPref, writePref } from "./lib/prefs";
import { isEditableTarget, matchShortcut } from "./lib/shortcuts";

const spikeMode = new URLSearchParams(location.search).has("spike");
let autoSwitchedToBill = false;
let nextToastId = 1;

function SpikePanel() {
  const [lastAction, setLastAction] = useState<unknown>(null);
  const [errors, setErrors] = useState<Array<FeedError & { fixture: string }>>([]);
  const [dataModel, setDataModel] = useState<unknown>(null);

  useEffect(() => {
    // Deferred so the app-level feed-error listener (a parent effect) is already subscribed.
    queueMicrotask(() => {
      const all: Array<FeedError & { fixture: string }> = [];
      for (const f of spikeFixtures) {
        for (const e of feed(f.envelopes)) all.push({ ...e, fixture: f.name });
      }
      setErrors(all);
      setDataModel(rendererDataModel());
    });
    return onAction((action) => {
      setLastAction(action);
      setDataModel(rendererDataModel());
    });
  }, []);

  return (
    <aside className="spike-panel">
      <h3>Spike log</h3>
      <p>Feed errors: {errors.length}</p>
      {errors.map((e, i) => (
        <pre key={i} className="spike-error">
          [{e.fixture}] {e.message}
          {"\n"}
          {JSON.stringify(e.envelope).slice(0, 300)}
        </pre>
      ))}
      <h4>Last ActionPayload</h4>
      <pre data-testid="last-action">{JSON.stringify(lastAction, null, 2)}</pre>
      <h4>getRendererDataModel("v0.9")</h4>
      <pre data-testid="data-model">{JSON.stringify(dataModel, null, 2)}</pre>
    </aside>
  );
}

export function App() {
  const mobile = useMediaQuery(MOBILE_QUERY);
  const [pane, setPane] = useState<Pane>("chat");
  const [unseen, setUnseen] = useState<Record<Pane, boolean>>({ chat: false, bill: false });
  const [debugEnabled, setDebugEnabled] = useState(isLogDebug);
  const [debugOpen, setDebugOpen] = useState(
    () => isLogDebug() && (new URLSearchParams(location.search).get("log") === "open" || readPref("a2ui-debug-open", false, parseFlag)),
  );
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const paneRef = useRef(pane);
  paneRef.current = pane;
  const mobileRef = useRef(mobile);
  mobileRef.current = mobile;

  const openDebug = useCallback((open: boolean) => {
    setDebugOpen(open);
    writePref("a2ui-debug-open", open ? "1" : "0");
    if (!open) document.getElementById("debug-toggle")?.focus({ preventScroll: true });
  }, []);

  const showPane = useCallback((next: Pane) => {
    debug("nav", "pane", { pane: next });
    setPane(next);
    setUnseen((u) => ({ ...u, [next]: false }));
  }, []);

  const onRenderError = useCallback(
    (errors: FeedError[]) =>
      setToast({
        id: nextToastId++,
        text: `Часть интерфейса не отрисовалась (${errors.length}). Подробности — в отладке.`,
        ...(isLogDebug() ? { actionLabel: "Подробнее", onAction: () => openDebug(true) } : {}),
      }),
    [openDebug],
  );
  const debugFeed = useDebugFeed(onRenderError);
  const dismissToast = useCallback(() => setToast(null), []);

  useEffect(() => {
    if (!spikeMode) connect();
  }, []);

  // Phones: jump to the bill the first time one appears; mark the hidden pane as having news.
  useEffect(() => {
    const created = processor.onSurfaceCreated(() => {
      if (mobileRef.current && !autoSwitchedToBill) {
        autoSwitchedToBill = true;
        info("nav", "auto-switch to bill");
        showPane("bill");
      }
    });
    const unsub = subscribe((e) => {
      if (e.kind === "a2ui" && paneRef.current !== "bill") setUnseen((u) => (u.bill ? u : { ...u, bill: true }));
      if (e.kind === "chat" && e.event.type === "delta" && paneRef.current !== "chat") setUnseen((u) => (u.chat ? u : { ...u, chat: true }));
    });
    return () => {
      created.unsubscribe();
      unsub();
    };
  }, [showPane]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const action = matchShortcut(e, isEditableTarget(e.target));
      if (!action) return;
      debug("shortcut", action);
      switch (action) {
        case "closeOverlays":
          if (debugOpen) openDebug(false);
          else if (toast) dismissToast();
          else return;
          break;
        case "toggleDebug":
          if (!debugEnabled) {
            setDebugMode(true);
            setDebugEnabled(true);
          }
          openDebug(!debugOpen);
          break;
        case "focusComposer":
          if (mobileRef.current) showPane("chat");
          requestAnimationFrame(() => composerRef.current?.focus());
          break;
        case "showChat":
          showPane("chat");
          break;
        case "showBill":
          showPane("bill");
          break;
      }
      e.preventDefault();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [debugEnabled, debugOpen, toast, openDebug, dismissToast, showPane]);

  const header = (
    <AppHeader
      subtitle={spikeMode ? "A2UI v0.9 · spikes" : "A2UI v0.9"}
      offline={spikeMode}
      debugEnabled={debugEnabled}
      debugOpen={debugOpen}
      debugErrors={debugFeed.renderErrors.length}
      onToggleDebug={() => openDebug(!debugOpen)}
    />
  );
  const overlays = (
    <>
      {debugEnabled && <DebugDrawer open={debugOpen} feed={debugFeed} onClose={() => openDebug(false)} />}
      <Toast toast={toast} onDismiss={dismissToast} />
    </>
  );

  if (spikeMode) {
    return (
      <div className="app">
        {header}
        <main className="app-spike">
          <div className="pane pane-surfaces">
            <Surfaces />
          </div>
          <SpikePanel />
        </main>
        {overlays}
      </div>
    );
  }

  const paneProps = (p: Pane, label: string) =>
    mobile
      ? { id: `pane-${p}`, role: "tabpanel", "aria-labelledby": `tab-${p}`, hidden: pane !== p }
      : { id: `pane-${p}`, "aria-label": label };

  return (
    <div className={`app${mobile ? " is-mobile" : ""}`}>
      {header}
      <main className="app-main">
        <section className="pane pane-chat" {...paneProps("chat", "Чат с агентом")}>
          <Chat composerRef={composerRef} />
        </section>
        <section className="pane pane-surfaces" {...paneProps("bill", "Счёт")}>
          <Surfaces />
        </section>
      </main>
      {mobile && <MobileTabBar active={pane} unseen={unseen} onChange={showPane} />}
      {overlays}
    </div>
  );
}
