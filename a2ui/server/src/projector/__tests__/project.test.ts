import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { BillStore } from "../../domain/store.js";
import { buildControlExample } from "../../domain/fixtures/control-example.js";
import { projectBill } from "../project.js";
import { BillViewModelSchema, billViewModelJsonSchema, type BillViewModel } from "../view-model.js";

const store = new BillStore();
const { billId, ids } = buildControlExample(store);
const bill = store.getBill(billId);

function nonEmptyRowLists(vm: BillViewModel): string[] {
  return (["equalRows", "exactRows", "sharesRows"] as const).filter((k) => vm.editor[k].length > 0);
}

describe("projectBill on the control example", () => {
  const vm = projectBill(bill);

  it("matches the view-model schema", () => {
    assert.equal(BillViewModelSchema.safeParse(vm).success, true);
  });

  it("projects header, people and items", () => {
    assert.deepEqual(vm.bill, { title: "Bermuda", currency: "MDL", totalText: "2860.00" });
    assert.equal(vm.people.length, 4);
    assert.deepEqual(vm.items.map((i) => i.title), ["Еда", "Кальяны", "Вино", "Чаевые"]);
    assert.equal(vm.items[0].splitText, "поровну: все");
    assert.equal(vm.items[1].splitText, "доли: Аня 2, Боря 1, Вика 1");
    assert.equal(vm.items[2].splitText, "суммы: Аня 250.00, Боря 250.00, Вика 100.00");
    assert.equal(vm.items[1].payerName, "Аня");
    assert.equal(vm.items[0].priceText, "1200.00");
  });

  it("selects the first item by default", () => {
    assert.equal(vm.editor.itemId, ids.items.food);
    assert.deepEqual(vm.items.map((i) => i.isSelectedText), ["▶", "", "", ""]);
    assert.deepEqual(nonEmptyRowLists(vm), ["equalRows"]);
    assert.ok(vm.editor.equalRows.every((r) => r.included && r.shareText === "300.00"));
    assert.deepEqual(vm.editor.payerOptions.map((o) => o.markText), ["", "●", "", ""]);
  });

  it("summary rows and transfers", () => {
    const vika = vm.summary.rows.find((r) => r.name === "Вика")!;
    assert.deepEqual(vika, { personId: ids.people.vika, name: "Вика", owesText: "665.00", paidText: "260.00", balanceText: "−405.00" });
    assert.equal(vm.summary.rows.find((r) => r.name === "Аня")!.balanceText, "+385.00");
    assert.equal(vm.summary.transfers.length, 3);
    assert.match(vm.summary.transfers[0].text, /^\S+ → \S+ \d+\.\d\d$/);
    assert.deepEqual(vm.errors.removePerson, { message: "", items: [] });
  });

  it("editor rows follow the selected item's split type", () => {
    const shares = projectBill(bill, { selectedItemId: ids.items.hookah });
    assert.deepEqual(nonEmptyRowLists(shares), ["sharesRows"]);
    assert.deepEqual(shares.editor.sharesRows.map((r) => [r.name, r.weightText, r.shareText]), [
      ["Аня", "2", "400.00"],
      ["Боря", "1", "200.00"],
      ["Вика", "1", "200.00"],
      ["Гена", "0", "0.00"],
    ]);
    assert.equal(shares.editor.splitTypeText, "Доли");

    const exact = projectBill(bill, { selectedItemId: ids.items.wine });
    assert.deepEqual(nonEmptyRowLists(exact), ["exactRows"]);
    assert.deepEqual(exact.editor.exactRows.map((r) => r.amountText), ["250.00", "250.00", "100.00", "0.00"]);
  });

  it("a pending split type shows that type's defaults", () => {
    const vm2 = projectBill(bill, { selectedItemId: ids.items.food, pendingSplitType: { itemId: ids.items.food, type: "exact" } });
    assert.equal(vm2.editor.splitType, "exact");
    assert.deepEqual(nonEmptyRowLists(vm2), ["exactRows"]);
    assert.ok(vm2.editor.exactRows.every((r) => r.amountText === "0.00"));
    assert.equal(vm2.items[0].splitText, "поровну: все", "stored split is unchanged");
  });

  it("exactly one rows list is non-empty for every item", () => {
    for (const item of bill.items) {
      assert.equal(nonEmptyRowLists(projectBill(bill, { selectedItemId: item.id })).length, 1, item.title);
    }
  });

  it("ui errors and editor errors are projected", () => {
    const vm3 = projectBill(bill, {
      errors: { removePerson: { message: "Нельзя удалить", items: [{ itemId: ids.items.food, title: "Еда" }] } },
      editorError: { message: "Сумма не совпадает", remainingText: "Не распределено 10.00" },
    });
    assert.equal(vm3.errors.removePerson.items[0].title, "Еда");
    assert.equal(vm3.editor.remainingText, "Не распределено 10.00");
  });

  it("an empty bill has an empty editor", () => {
    const s = new BillStore();
    const empty = s.createBill("Пусто", "MDL", ["Аня"]);
    const vm4 = projectBill(empty);
    assert.equal(vm4.editor.itemId, "");
    assert.deepEqual(nonEmptyRowLists(vm4), []);
    assert.equal(BillViewModelSchema.safeParse(vm4).success, true);
  });

  it("produces a JSON Schema for the system prompt", () => {
    const schema = billViewModelJsonSchema();
    assert.equal(schema.type, "object");
    assert.ok(JSON.stringify(schema).includes("sharesRows"));
  });
});
