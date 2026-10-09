import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { barPercent, pieSlices, seriesColor, toChartItems, wedgePath } from "../chart-math";

const items = [
  { label: "Аня", value: 1400, displayText: "1400.00 MDL" },
  { label: "Боря", value: 1200, displayText: "1200.00 MDL" },
  { label: "Вика", value: 260, displayText: "260.00 MDL" },
  { label: "Гена", value: 0, displayText: "0.00 MDL" },
];

describe("seriesColor", () => {
  it("uses the eight fixed slots in order, then folds into the neutral colour", () => {
    assert.equal(seriesColor(0), "var(--chart-1)");
    assert.equal(seriesColor(7), "var(--chart-8)");
    assert.equal(seriesColor(8), "var(--chart-other)");
  });

  it("honours only a valid #RRGGBB override", () => {
    assert.equal(seriesColor(2, "#123abc"), "#123abc");
    assert.equal(seriesColor(2, "red"), "var(--chart-3)");
  });
});

describe("toChartItems", () => {
  it("drops malformed entries and clamps negatives", () => {
    const raw = [items[0], null, { label: "x" }, { label: "y", value: Number.NaN }, { label: "z", value: -3, displayText: "−3" }];
    assert.deepEqual(toChartItems(raw), [items[0], { label: "z", value: 0, displayText: "−3" }]);
  });

  it("an unresolved binding is an empty chart", () => {
    assert.deepEqual(toChartItems(undefined), []);
    assert.deepEqual(toChartItems({ path: "/x" }), []);
  });
});

describe("barPercent", () => {
  it("scales to the largest value", () => {
    assert.equal(barPercent(1400, items), 100);
    assert.equal(Math.round(barPercent(260, items)), 19);
    assert.equal(barPercent(0, items), 0);
  });

  it("all zeros draw no bars", () => {
    assert.equal(barPercent(0, [{ label: "a", value: 0, displayText: "0" }]), 0);
  });
});

describe("pieSlices", () => {
  it("covers 360° clockwise in input order and skips zero values", () => {
    const slices = pieSlices(items);
    assert.deepEqual(slices.map((s) => s.index), [0, 1, 2]);
    assert.equal(slices[0].start, 0);
    assert.ok(Math.abs(slices.at(-1)!.end - 360) < 1e-9);
    assert.ok(Math.abs(slices.reduce((s, x) => s + x.share, 0) - 1) < 1e-9);
  });

  it("an all-zero chart has no slices", () => {
    assert.deepEqual(pieSlices([{ label: "a", value: 0, displayText: "0" }]), []);
  });
});

describe("wedgePath", () => {
  it("a pie wedge starts at the centre; a large sweep sets the large-arc flag", () => {
    assert.match(wedgePath(50, 40, 0, 0, 90), /^M 50 50 L 50 10 A 40 40 0 0 1 90 50 Z$/);
    assert.match(wedgePath(50, 40, 0, 0, 270), / 0 1 1 /);
  });

  it("a donut segment has an outer and an inner arc", () => {
    assert.equal((wedgePath(50, 40, 20, 0, 90).match(/A /g) ?? []).length, 2);
  });

  it("a full circle is drawn as two half arcs (plus a hole for a donut)", () => {
    assert.equal((wedgePath(50, 40, 0, 0, 360).match(/A /g) ?? []).length, 2);
    assert.equal((wedgePath(50, 40, 20, 0, 360).match(/A /g) ?? []).length, 4);
  });

  it("an empty sweep draws nothing", () => {
    assert.equal(wedgePath(50, 40, 0, 10, 10), "");
  });
});
