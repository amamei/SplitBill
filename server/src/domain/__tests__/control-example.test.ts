import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { BillStore } from "../store.js";
import { buildControlExample } from "../fixtures/control-example.js";
import type { Summary } from "../summary.js";

const M = 100; // minor per major

function byName(summary: Summary) {
  return Object.fromEntries(summary.people.map((p) => [p.name, p]));
}

function applyTransfers(summary: Summary): Record<string, number> {
  const balances = Object.fromEntries(summary.people.map((p) => [p.personId, p.balance]));
  for (const t of summary.transfers) {
    balances[t.fromId] += t.amount;
    balances[t.toId] -= t.amount;
  }
  return balances;
}

describe("TZ §6 control example", () => {
  const store = new BillStore();
  const { billId, ids } = buildControlExample(store);
  const summary = store.getSummary(billId);
  const p = ids.people;

  it("allocates every item as in the §6 matrix", () => {
    const a = summary.allocations;
    assert.deepEqual(a[ids.items.food], { [p.anya]: 300 * M, [p.borya]: 300 * M, [p.vika]: 300 * M, [p.gena]: 300 * M });
    assert.deepEqual(a[ids.items.hookah], { [p.anya]: 400 * M, [p.borya]: 200 * M, [p.vika]: 200 * M });
    assert.deepEqual(a[ids.items.wine], { [p.anya]: 250 * M, [p.borya]: 250 * M, [p.vika]: 100 * M });
    assert.deepEqual(a[ids.items.tips], { [p.anya]: 65 * M, [p.borya]: 65 * M, [p.vika]: 65 * M, [p.gena]: 65 * M });
  });

  it("matches owes / paid / balance per person and the total", () => {
    const s = byName(summary);
    assert.deepEqual([s["Аня"].owes, s["Аня"].paid, s["Аня"].balance], [1015 * M, 1400 * M, 385 * M]);
    assert.deepEqual([s["Боря"].owes, s["Боря"].paid, s["Боря"].balance], [815 * M, 1200 * M, 385 * M]);
    assert.deepEqual([s["Вика"].owes, s["Вика"].paid, s["Вика"].balance], [665 * M, 260 * M, -405 * M]);
    assert.deepEqual([s["Гена"].owes, s["Гена"].paid, s["Гена"].balance], [365 * M, 0, -365 * M]);
    assert.equal(summary.total, 2860 * M);
    assert.equal(summary.people.reduce((acc, x) => acc + x.balance, 0), 0);
  });

  it("settles with exactly 3 transfers that zero every balance", () => {
    assert.equal(summary.transfers.length, 3);
    assert.ok(summary.transfers.length <= summary.people.length - 1);
    assert.ok(Object.values(applyTransfers(summary)).every((b) => b === 0));
    assert.ok(summary.transfers.every((t) => t.amount > 0));
  });

  it("S6: Гена joins the hookah with one share", () => {
    store.updateItem(billId, ids.items.hookah, {
      split: { type: "shares", weights: { [p.anya]: 2, [p.borya]: 1, [p.vika]: 1, [p.gena]: 1 } },
    });
    const after = store.getSummary(billId);
    assert.deepEqual(after.allocations[ids.items.hookah], {
      [p.anya]: 320 * M,
      [p.borya]: 160 * M,
      [p.vika]: 160 * M,
      [p.gena]: 160 * M,
    });
    const s = byName(after);
    assert.deepEqual([s["Аня"].owes, s["Аня"].balance], [935 * M, 465 * M]);
    assert.deepEqual([s["Боря"].owes, s["Боря"].balance], [775 * M, 425 * M]);
    assert.deepEqual([s["Вика"].owes, s["Вика"].balance], [625 * M, -365 * M]);
    assert.deepEqual([s["Гена"].owes, s["Гена"].balance], [525 * M, -525 * M]);
    assert.ok(Object.values(applyTransfers(after)).every((b) => b === 0));
    assert.ok(after.transfers.length <= 3);
  });
});
