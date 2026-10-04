import { useEffect, useState } from "react";
import { connect, subscribe } from "./a2ui/api";
import { feed, onAction, rendererDataModel, type FeedError } from "./a2ui/processor";
import { Chat } from "./components/Chat";
import { MessageLog } from "./components/MessageLog";
import { Surfaces } from "./components/Surfaces";
import { ThemeToggle } from "./components/ThemeToggle";
import { spikeFixtures } from "./fixtures/spike";

const spikeMode = new URLSearchParams(location.search).has("spike");

function SpikePanel() {
  const [lastAction, setLastAction] = useState<unknown>(null);
  const [errors, setErrors] = useState<Array<FeedError & { fixture: string }>>([]);
  const [dataModel, setDataModel] = useState<unknown>(null);

  useEffect(() => {
    const all: Array<FeedError & { fixture: string }> = [];
    for (const f of spikeFixtures) {
      for (const e of feed(f.envelopes)) all.push({ ...e, fixture: f.name });
    }
    setErrors(all);
    setDataModel(rendererDataModel());
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

/** Red banner for envelopes the renderer rejected (TZ §7 "Надёжность"). */
function FeedErrors() {
  const [errors, setErrors] = useState<FeedError[]>([]);
  useEffect(() => subscribe((e) => e.kind === "a2ui" && e.errors.length > 0 && setErrors((prev) => [...prev, ...e.errors].slice(-5))), []);
  if (errors.length === 0) return null;
  return (
    <div className="feed-errors" role="alert">
      <strong>Рендерер отклонил сообщения A2UI ({errors.length})</strong>
      <button type="button" onClick={() => setErrors([])}>
        скрыть
      </button>
      {errors.map((e, i) => (
        <pre key={i}>
          {e.message}
          {"\n"}
          {JSON.stringify(e.envelope).slice(0, 400)}
        </pre>
      ))}
    </div>
  );
}

function ConnectionDot() {
  const [open, setOpen] = useState(false);
  useEffect(() => subscribe((e) => e.kind === "connection" && setOpen(e.open)), []);
  return <span className={`conn ${open ? "conn-on" : "conn-off"}`} title={open ? "SSE подключён" : "нет связи с сервером"} />;
}

export function App() {
  useEffect(() => {
    if (!spikeMode) connect();
  }, []);

  if (spikeMode) {
    return (
      <div className="app">
        <header className="app-header">
          <h1>Split Bill · A2UI — spikes</h1>
        </header>
        <main className="app-spike">
          <div className="surfaces">
            <Surfaces />
          </div>
          <SpikePanel />
        </main>
      </div>
    );
  }

  return (
    <div className="app">
      <header className="app-header">
        <h1>
          Split Bill · A2UI v0.9 <ConnectionDot />
        </h1>
        <ThemeToggle />
      </header>
      <FeedErrors />
      <main className="app-main">
        <Chat />
        <div className="surfaces">
          <Surfaces />
        </div>
      </main>
      <MessageLog />
    </div>
  );
}
