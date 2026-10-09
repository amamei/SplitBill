import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isNearBottom } from "../scroll";

describe("isNearBottom", () => {
  it("is true exactly at the threshold and false just past it", () => {
    assert.equal(isNearBottom(452, 500, 1000), true); // 48px left
    assert.equal(isNearBottom(451, 500, 1000), false); // 49px left
  });

  it("is true at the very bottom", () => {
    assert.equal(isNearBottom(500, 500, 1000), true);
  });

  it("is true for an empty or non-scrolling list", () => {
    assert.equal(isNearBottom(0, 500, 0), true);
    assert.equal(isNearBottom(0, 500, 300), true);
  });

  it("honours a custom threshold", () => {
    assert.equal(isNearBottom(400, 500, 1000, 100), true);
    assert.equal(isNearBottom(399, 500, 1000, 100), false);
  });
});
