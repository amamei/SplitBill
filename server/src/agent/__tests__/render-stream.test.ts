import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Session } from "../session.js";
import { createRenderStreamer } from "../render-stream.js";
import { renderSurface } from "../tools.js";
import { buildControlExample } from "../../domain/fixtures/control-example.js";
import type { A2uiEnvelope } from "../../a2ui/envelopes.js";

const components = Array.from({ length: 12 }, (_, i) =>
  i === 0
    ? { id: "root", component: "Column", children: Array.from({ length: 11 }, (_, j) => `t${j + 1}`) }
    : { id: `t${i}`, component: "Text", text: `строка ${i}` },
);

function setup() {
  const session = new Session("s");
  const { billId } = buildControlExample(session.store);
  session.billId = billId;
  const sent: A2uiEnvelope[] = [];
  session.subscribe((e, d) => e === "a2ui" && sent.push(d as A2uiEnvelope));
  const types = () => sent.map((e) => Object.keys(e).find((k) => k !== "version"));
  return { session, sent, types };
}

describe("render streaming", () => {
  it("creates the surface early, streams batches, then run() sends only data", () => {
    const { session, sent, types } = setup();
    const streamer = createRenderStreamer(session, { enabled: true });
    const json = JSON.stringify({ surfaceId: "bill", components });
    streamer.start(1, "toolu_1", "render_surface");
    streamer.delta(1, json.slice(0, 30));
    assert.deepEqual(types(), ["createSurface"], "createSurface as soon as the id is known");
    streamer.delta(1, json.slice(30));
    assert.deepEqual(types(), ["createSurface", "updateComponents"], "first batch of 8 flushed");
    streamer.stop(1);
    assert.deepEqual(types(), ["createSurface", "updateComponents", "updateComponents"]);
    const streamedCount = sent
      .flatMap((e) => ("updateComponents" in e ? e.updateComponents.components : []))
      .length;
    assert.equal(streamedCount, 12);

    renderSurface(session, { surfaceId: "bill", components }, "toolu_1");
    assert.deepEqual(types().slice(3), ["updateDataModel"]);
    assert.equal(session.streamedRenders.size, 0);
    streamer.abortAll();
    assert.equal(types().length, 4, "nothing deleted after a completed render");
  });

  it("an invalid streamed tree is deleted after validation", () => {
    const { session, types } = setup();
    const streamer = createRenderStreamer(session, { enabled: true });
    const bad = [{ id: "root", component: "Column", children: ["ghost"] }];
    streamer.start(0, "toolu_2", "render_surface");
    streamer.delta(0, JSON.stringify({ surfaceId: "chart-1", components: bad }));
    streamer.stop(0);
    assert.throws(() => renderSurface(session, { surfaceId: "chart-1", components: bad }, "toolu_2"));
    assert.deepEqual(types(), ["createSurface", "updateComponents", "deleteSurface"]);
  });

  it("abortAll deletes a surface whose call never completed", () => {
    const { session, types } = setup();
    const streamer = createRenderStreamer(session, { enabled: true });
    streamer.start(0, "toolu_3", "render_surface");
    streamer.delta(0, '{"surfaceId": "chart-2", "components": [{"id": "root", "component": "Text", "text": "x"}');
    streamer.abortAll();
    assert.deepEqual(types(), ["createSurface", "deleteSurface"]);
  });

  it("A2UI_STREAM=0 disables streaming", () => {
    const { session, types } = setup();
    const streamer = createRenderStreamer(session, { enabled: false });
    streamer.start(0, "toolu_4", "render_surface");
    streamer.delta(0, JSON.stringify({ surfaceId: "bill", components }));
    streamer.stop(0);
    assert.deepEqual(types(), []);
  });
});
