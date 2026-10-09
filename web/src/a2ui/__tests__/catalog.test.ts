import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { basicCatalog } from "@a2ui/react/v0_9";
import { appCatalog, variantClass } from "../catalog";

describe("appCatalog", () => {
  it("keeps the basic catalog id and component names", () => {
    assert.equal(appCatalog.id, basicCatalog.id);
    assert.deepEqual([...appCatalog.components.keys()].sort(), [...basicCatalog.components.keys()].sort());
    assert.equal(appCatalog.components.size, 18);
  });

  it("replaces only the Button implementation", () => {
    for (const [name, impl] of appCatalog.components) {
      if (name === "Button") assert.notEqual(impl, basicCatalog.components.get(name));
      else assert.equal(impl, basicCatalog.components.get(name), name);
    }
  });

  it("keeps the basic functions", () => {
    assert.deepEqual([...appCatalog.functions.keys()].sort(), [...basicCatalog.functions.keys()].sort());
  });
});

describe("variantClass", () => {
  it("maps known variants and defaults the rest", () => {
    assert.equal(variantClass("primary"), "a2ui-btn a2ui-btn--primary");
    assert.equal(variantClass("borderless"), "a2ui-btn a2ui-btn--borderless");
    assert.equal(variantClass(undefined), "a2ui-btn a2ui-btn--default");
    assert.equal(variantClass("danger"), "a2ui-btn a2ui-btn--default");
  });
});
