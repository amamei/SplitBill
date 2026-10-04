import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { appCatalog } from "../catalog";
import { feed, processor, skipReason, type A2uiEnvelope } from "../processor";

const create = (surfaceId: string): A2uiEnvelope => ({ version: "v0.9", createSurface: { surfaceId, catalogId: appCatalog.id } });
const del = (surfaceId: string): A2uiEnvelope => ({ version: "v0.9", deleteSurface: { surfaceId } });

describe("skipReason", () => {
  const live = (ids: string[]) => (id: string) => ids.includes(id);

  it("skips createSurface for a live surface (SSE replay)", () => {
    assert.equal(skipReason(create("bill"), live(["bill"])), "duplicate createSurface");
    assert.equal(skipReason(create("bill"), live([])), null);
  });

  it("skips deleteSurface for a surface that is not live (reset reaching another tab)", () => {
    assert.equal(skipReason(del("bill"), live([])), "deleteSurface: unknown surface");
    assert.equal(skipReason(del("bill"), live(["bill"])), null);
  });

  it("lets other envelopes through", () => {
    assert.equal(skipReason({ version: "v0.9", updateDataModel: { surfaceId: "x", value: {} } }, live([])), null);
  });
});

describe("feed: deleteSurface", () => {
  afterEach(() => {
    for (const id of [...processor.getSurfaces().keys()]) feed([del(id)]);
  });

  it("an unknown surface is skipped without errors", () => {
    assert.deepEqual(feed([del("nope")]), []);
    assert.equal(processor.getSurfaces().size, 0);
  });

  it("create then delete removes the surface; a second delete is a no-op", () => {
    assert.deepEqual(feed([create("bill"), del("bill")]), []);
    assert.equal(processor.getSurface("bill"), undefined);
    assert.deepEqual(feed([del("bill")]), []);
  });
});
