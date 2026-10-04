import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createSurface } from "../../a2ui/envelopes.js";
import { buildControlExample } from "../../domain/fixtures/control-example.js";
import { dispatchAction } from "../actions.js";
import { Session, type SseEventName } from "../session.js";
import { TurnRecorder } from "../telemetry.js";
import { action, controlSession } from "./helpers.js";

function capture(session: Session): Array<{ event: SseEventName; data: unknown }> {
  const events: Array<{ event: SseEventName; data: unknown }> = [];
  session.subscribe((event, data) => events.push({ event, data }));
  return events;
}

describe("Session.reset", () => {
  it("bill + extra surface → reset event, then deleteSurface per surface; all state cleared", () => {
    const { session } = controlSession();
    session.emit([createSurface("chart-1")]);
    session.messages.push({ role: "user", content: "Гена курил" });
    session.telemetry.push(new TurnRecorder(1, "chat", "test-model", "v").finish());
    session.turnCounter = 3;
    const events = capture(session);

    const { deletedSurfaces } = session.reset();

    assert.deepEqual(deletedSurfaces, ["bill", "chart-1"]);
    assert.deepEqual(events, [
      { event: "chat", data: { type: "reset" } },
      { event: "a2ui", data: { version: "v0.9", deleteSurface: { surfaceId: "bill" } } },
      { event: "a2ui", data: { version: "v0.9", deleteSurface: { surfaceId: "chart-1" } } },
    ]);
    assert.equal(session.billId, undefined);
    assert.equal(session.lastVm, undefined);
    assert.deepEqual(session.ui, {});
    assert.equal(session.modelSeenVersion, 0);
    assert.equal(session.turnCounter, 0);
    assert.equal(session.messages.length, 0);
    assert.equal(session.telemetry.length, 0);
    assert.equal(session.surfaces.size, 0);
    assert.equal(session.envelopeLog.length, 0, "a reconnect must replay nothing");
    assert.equal(session.streamedRenders.size, 0);
    assert.equal(session.store.version, 0);
  });

  it("fresh session → only the reset event, no envelopes", () => {
    const session = new Session("fresh");
    const events = capture(session);
    assert.deepEqual(session.reset(), { deletedSurfaces: [] });
    assert.deepEqual(events, [{ event: "chat", data: { type: "reset" } }]);
  });

  it("busy session → throws and leaves state untouched", () => {
    const { session } = controlSession();
    const billId = session.billId;
    session.busy = true;
    const events = capture(session);
    assert.throws(() => session.reset(), /busy/);
    assert.equal(session.billId, billId);
    assert.ok(session.surfaces.has("bill"));
    assert.equal(events.length, 0);
  });

  it("after reset, UI actions no-op until a new bill exists; a new bill starts fresh", () => {
    const { session } = controlSession();
    session.reset();
    assert.deepEqual(dispatchAction(session, action("add_person", { name: "Дима" })), { kind: "handled", envelopes: [] });

    const { billId } = buildControlExample(session.store);
    session.billId = billId;
    assert.equal(billId, "b1", "new store restarts bill numbering");
    assert.equal(session.project().people.length, 4);
  });
});
