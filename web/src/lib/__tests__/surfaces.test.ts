import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { orderSurfaces, safeAccent, slugHeading, surfaceTitle } from "../surfaces";

describe("orderSurfaces", () => {
  it("puts bill first and keeps creation order for the rest", () => {
    const ids = orderSurfaces([{ id: "chart-1" }, { id: "bill" }, { id: "chart-2" }]).map((s) => s.id);
    assert.deepEqual(ids, ["bill", "chart-1", "chart-2"]);
  });

  it("does not mutate its input", () => {
    const input = [{ id: "x" }, { id: "bill" }];
    orderSurfaces(input);
    assert.deepEqual(input.map((s) => s.id), ["x", "bill"]);
  });
});

describe("surfaceTitle", () => {
  it("names the bill «Счёт» regardless of theme", () => {
    assert.equal(surfaceTitle("bill"), "Счёт");
    assert.equal(surfaceTitle("bill", { agentDisplayName: "Split Bill" }), "Счёт");
  });

  it("prefers the theme display name for other surfaces", () => {
    assert.equal(surfaceTitle("chart-1", { agentDisplayName: "  Траты  " }), "Траты");
  });

  it("numbers charts and humanizes other ids", () => {
    assert.equal(surfaceTitle("chart-2"), "Диаграмма 2");
    assert.equal(surfaceTitle("who_owes-whom"), "Who owes whom");
    assert.equal(surfaceTitle("chart-2", { agentDisplayName: 42 }), "Диаграмма 2");
  });
});

describe("safeAccent", () => {
  it("accepts only #RRGGBB", () => {
    assert.equal(safeAccent({ primaryColor: "#2f6F5e" }), "#2f6F5e");
    for (const bad of ["red", "#fff", "javascript:alert(1)", "#2f6f5e; color: red", 123, undefined]) {
      assert.equal(safeAccent({ primaryColor: bad }), undefined, String(bad));
    }
    assert.equal(safeAccent(null), undefined);
  });
});

describe("slugHeading", () => {
  it("keeps Cyrillic and de-duplicates", () => {
    const used = new Set<string>();
    assert.equal(slugHeading("Участники", used), "sec-участники");
    assert.equal(slugHeading("Редактор позиции", used), "sec-редактор-позиции");
    assert.equal(slugHeading("Участники", used), "sec-участники-2");
    assert.equal(slugHeading("Участники", used), "sec-участники-3");
  });

  it("falls back for punctuation-only text", () => {
    assert.equal(slugHeading("—!?", new Set()), "sec-section");
  });
});
