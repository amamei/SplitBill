import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { dispatchAction, type DispatchResult } from "../actions.js";
import type { BillViewModel } from "../../projector/view-model.js";
import { action, controlSession, patches } from "./helpers.js";

function handled(result: DispatchResult) {
  assert.equal(result.kind, "handled");
  if (result.kind !== "handled") throw new Error("unreachable");
  for (const e of result.envelopes) {
    assert.ok("updateDataModel" in e, "UI actions emit only updateDataModel");
    assert.equal((e as { updateDataModel: { surfaceId: string } }).updateDataModel.surfaceId, "bill");
  }
  return patches(result.envelopes);
}

const balances = (vm: BillViewModel) => vm.summary.rows.map((r) => r.balanceText);

describe("dispatchAction", () => {
  it("select_item switches the editor", () => {
    const { session, ids } = controlSession();
    const p = handled(dispatchAction(session, action("select_item", { itemId: ids.items.hookah })));
    assert.ok("/editor" in p && "/items" in p);
    assert.equal((p["/editor"] as BillViewModel["editor"]).splitType, "shares");
  });

  it("set_split_type exact fills exactRows only and keeps totals", () => {
    const { session } = controlSession();
    const before = balances(session.lastVm!);
    const p = handled(dispatchAction(session, action("set_split_type", { type: "exact" })));
    const editor = p["/editor"] as BillViewModel["editor"];
    assert.equal(editor.exactRows.length, 4);
    assert.deepEqual([editor.equalRows.length, editor.sharesRows.length], [0, 0]);
    assert.ok(!("/summary" in p));
    assert.deepEqual(balances(session.lastVm!), before);
  });

  it("save_item exact 250/250/90 → «Не распределено 10.00», bill unchanged, typed values kept", () => {
    const { session, ids } = controlSession();
    handled(dispatchAction(session, action("select_item", { itemId: ids.items.wine })));
    const editor = structuredClone(session.lastVm!.editor);
    editor.exactRows[2].amountText = "90";
    const billBefore = session.store.getBill(session.billId!);
    const p = handled(dispatchAction(session, action("save_item", { editor })));
    assert.equal(p["/editor/remainingText"], "Не распределено 10.00");
    assert.match(String(p["/editor/error"]), /не распределено 10\.00/);
    assert.ok(!("/editor/exactRows" in p), "typed rows are not overwritten");
    assert.equal(session.lastVm!.editor.exactRows[2].amountText, "90");
    assert.deepEqual(session.store.getBill(session.billId!), billBefore);
  });

  it("save_item exact 250/250/100 saves and clears the error", () => {
    const { session, ids } = controlSession();
    handled(dispatchAction(session, action("select_item", { itemId: ids.items.wine })));
    const bad = structuredClone(session.lastVm!.editor);
    bad.exactRows[2].amountText = "90";
    handled(dispatchAction(session, action("save_item", { editor: bad })));
    const good = structuredClone(session.lastVm!.editor);
    good.exactRows[2].amountText = "100";
    good.exactRows[3].amountText = "";
    good.title = "Вино красное";
    const p = handled(dispatchAction(session, action("save_item", { editor: good })));
    assert.equal(p["/editor/remainingText"], "");
    assert.equal(p["/editor/error"], "");
    assert.equal(session.store.getBill(session.billId!).items[2].title, "Вино красное");
    assert.deepEqual(p["/editor/exactRows"], session.lastVm!.editor.exactRows, "normalized amounts pushed back");
    assert.equal(session.lastVm!.editor.exactRows[2].amountText, "100.00");
  });

  it("save_item after switching Еда to shares stores the weights", () => {
    const { session, ids } = controlSession();
    handled(dispatchAction(session, action("set_split_type", { type: "shares" })));
    const editor = structuredClone(session.lastVm!.editor);
    editor.sharesRows[0].weightText = "2";
    handled(dispatchAction(session, action("save_item", { editor })));
    const food = session.store.getBill(session.billId!).items.find((i) => i.id === ids.items.food)!;
    assert.deepEqual(food.split, { type: "shares", weights: { [ids.people.anya]: 2, [ids.people.borya]: 1, [ids.people.vika]: 1, [ids.people.gena]: 1 } });
    assert.equal(session.ui.pendingSplitType, undefined);
  });

  it("set_payer updates payer and summary without touching unsaved editor rows", () => {
    const { session, ids } = controlSession();
    handled(dispatchAction(session, action("select_item", { itemId: ids.items.wine })));
    const p = handled(dispatchAction(session, action("set_payer", { personId: ids.people.gena })));
    assert.ok(!Object.keys(p).some((k) => k.startsWith("/editor/exactRows")));
    assert.equal(p["/editor/payerName"], "Гена");
    assert.ok("/summary" in p);
  });

  it("remove_person Гена → error block with Еда and Чаевые; fix_item selects Еда and clears it", () => {
    const { session, ids } = controlSession();
    handled(dispatchAction(session, action("select_item", { itemId: ids.items.wine })));
    const p = handled(dispatchAction(session, action("remove_person", { personId: ids.people.gena })));
    const errors = p["/errors"] as BillViewModel["errors"];
    assert.deepEqual(errors.removePerson.items.map((i) => i.title), ["Еда", "Чаевые"]);
    assert.match(errors.removePerson.message, /Гена/);
    assert.equal(session.store.getBill(session.billId!).people.length, 4);

    const fix = handled(dispatchAction(session, action("fix_item", { itemId: errors.removePerson.items[0].itemId })));
    assert.equal((fix["/editor"] as BillViewModel["editor"]).itemId, ids.items.food);
    assert.deepEqual((fix["/errors"] as BillViewModel["errors"]).removePerson.items, []);
  });

  it("add_person «Дима» → 5 people, allocations unchanged, draft cleared", () => {
    const { session } = controlSession();
    const before = session.store.getSummary(session.billId!).allocations;
    const p = handled(dispatchAction(session, action("add_person", { name: "Дима" })));
    assert.equal((p["/people"] as unknown[]).length, 5);
    assert.equal(p["/draft/personName"], "", "the typed name is cleared in the client");
    assert.deepEqual(session.store.getSummary(session.billId!).allocations, before);
  });

  it("add_person duplicate → general error, no change", () => {
    const { session } = controlSession();
    const p = handled(dispatchAction(session, action("add_person", { name: "аня" })));
    assert.match((p["/errors"] as BillViewModel["errors"]).general.message, /уже есть/);
    assert.equal(session.store.getBill(session.billId!).people.length, 4);
  });

  it("rename_person via template-relative context", () => {
    const { session, ids } = controlSession();
    const p = handled(dispatchAction(session, action("rename_person", { personId: ids.people.borya, name: "Борис" })));
    // The client already shows the typed name, so /people is not re-sent; derived texts are.
    assert.ok(!("/people" in p));
    assert.equal(session.lastVm!.people[1].name, "Борис");
    assert.match(JSON.stringify(p["/items"]), /Борис/);
    assert.match(JSON.stringify(p["/summary"]), /Борис/);
  });

  it("add_item parses major units and selects the new item; remove_item moves selection", () => {
    const { session } = controlSession();
    const p = handled(dispatchAction(session, action("add_item", { title: "Десерт", price: "150,50" })));
    const items = p["/items"] as BillViewModel["items"];
    assert.equal(items[4].priceText, "150.50");
    assert.equal((p["/editor"] as BillViewModel["editor"]).itemId, items[4].id);
    assert.deepEqual([p["/draft/itemTitle"], p["/draft/itemPrice"]], ["", ""]);

    const r = handled(dispatchAction(session, action("remove_item", { itemId: items[4].id })));
    assert.equal((r["/items"] as unknown[]).length, 4);
    assert.equal((r["/editor"] as BillViewModel["editor"]).itemId, items[0].id);
  });

  it("add_item with a bad price shows a general error", () => {
    const { session } = controlSession();
    const p = handled(dispatchAction(session, action("add_item", { title: "Х", price: "12.345" })));
    assert.match((p["/errors"] as BillViewModel["errors"]).general.message, /знак|сумм/i);
  });

  it("unknown action (remind) is forwarded to the agent", () => {
    const { session, ids } = controlSession();
    const result = dispatchAction(session, action("remind", { personId: ids.people.vika }));
    assert.deepEqual(result, { kind: "forward", userMessage: `[UI action] remind {"personId":"${ids.people.vika}"}` });
  });

  it("falls back to a2uiClientDataModel when the context is missing", () => {
    const { session } = controlSession();
    const clientVm = structuredClone(session.lastVm!);
    clientVm.draft.personName = "Женя";
    const p = handled(dispatchAction(session, action("add_person"), { version: "v0.9", surfaces: { bill: clientVm } }));
    assert.equal((p["/people"] as unknown[]).length, 5);
    assert.equal(p["/draft/personName"], "");
  });

  it("an action that changes nothing emits nothing", () => {
    const { session, ids } = controlSession();
    const result = dispatchAction(session, action("select_item", { itemId: ids.items.food }));
    assert.deepEqual(result, { kind: "handled", envelopes: [] });
  });

  it("every state-changing action emits ≥ 1 updateDataModel and no updateComponents", () => {
    const { session, ids } = controlSession();
    for (const a of [
      action("set_payer", { personId: ids.people.anya }),
      action("add_person", { name: "Дима" }),
      action("select_item", { itemId: ids.items.tips }),
    ]) {
      const result = dispatchAction(session, a);
      assert.equal(result.kind, "handled");
      if (result.kind === "handled") {
        assert.ok(result.envelopes.length >= 1, a.name);
        assert.ok(result.envelopes.every((e) => !("updateComponents" in e)));
      }
    }
  });
});
