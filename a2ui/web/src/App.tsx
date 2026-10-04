import { useEffect, useState } from "react";
import "./a2ui.css";
import { feed, onAction, rendererDataModel, type FeedError } from "./a2ui/processor";
import { Surfaces } from "./components/Surfaces";
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

export function App() {
  return (
    <div className="app">
      <header className="app-header">
        <h1>Split Bill · A2UI</h1>
      </header>
      <main className="app-main">
        <div className="surfaces">
          <Surfaces />
        </div>
        {spikeMode && <SpikePanel />}
      </main>
    </div>
  );
}
