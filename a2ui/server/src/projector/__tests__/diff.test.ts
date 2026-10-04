import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { BillStore } from "../../domain/store.js";
import { buildControlExample } from "../../domain/fixtures/control-example.js";
import { projectBill } from "../project.js";
import { diffViewModel } from "../diff.js";

describe("diffViewModel", () => {
  const store = new BillStore();
  const { billId, ids } = buildControlExample(store);
  const before = projectBill(store.getBill(billId));

  it("first diff replaces the whole model", () => {
    assert.deepEqual(diffViewModel(undefined, before), [{ path: "/", value: before }]);
  });

  it("identical view models yield no patches", () => {
    assert.deepEqual(diffViewModel(before, projectBill(store.getBill(billId))), []);
  });

  it("changing only the payer touches payer fields, items and summary — not editor rows", () => {
    store.updateItem(billId, ids.items.food, { paidById: ids.people.anya });
    const after = projectBill(store.getBill(billId));
    const paths = diffViewModel(before, after).map((p) => p.path).sort();
    assert.deepEqual(paths, ["/editor/payerId", "/editor/payerName", "/editor/payerOptions", "/items", "/summary"].sort());
    assert.ok(!paths.some((p) => p.startsWith("/editor/exactRows") || p.startsWith("/editor/equalRows")));
  });

  it("switching the selected item replaces the whole editor", () => {
    const vm = projectBill(store.getBill(billId));
    const next = projectBill(store.getBill(billId), { selectedItemId: ids.items.wine });
    const paths = diffViewModel(vm, next).map((p) => p.path);
    assert.deepEqual(paths, ["/items", "/editor"]);
  });

  it("switching the split type replaces the whole editor", () => {
    const vm = projectBill(store.getBill(billId));
    const next = projectBill(store.getBill(billId), { pendingSplitType: { itemId: ids.items.food, type: "shares" } });
    assert.deepEqual(diffViewModel(vm, next).map((p) => p.path), ["/editor"]);
  });

  it("draft fields are patched individually", () => {
    const vm = projectBill(store.getBill(billId), { draft: { personName: "Дима", itemTitle: "", itemPrice: "" } });
    const next = projectBill(store.getBill(billId));
    assert.deepEqual(diffViewModel(vm, next), [{ path: "/draft/personName", value: "" }]);
  });
});

describe("diffViewModel hints", () => {
  it("adding the first item clears /hints/items and /hints/editor with field patches", () => {
    const store = new BillStore();
    const b = store.createBill("Новый", "MDL", ["Аня", "Боря"]);
    const before = projectBill(store.getBill(b.id));
    store.addItem(b.id, { title: "Пицца", price: 30000, paidById: store.getBill(b.id).people[0]!.id });
    const patches = diffViewModel(before, projectBill(store.getBill(b.id)));
    const byPath = new Map(patches.map((p) => [p.path, p.value]));
    assert.equal(byPath.get("/hints/items"), "");
    assert.equal(byPath.get("/hints/editor"), "");
    assert.ok(!byPath.has("/hints"), "hints are diffed per field");
    assert.ok(!byPath.has("/hints/people"), "unchanged hint is not re-sent");
  });
});
