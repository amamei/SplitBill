import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { allocate } from "../allocate.js";
import { DomainError } from "../errors.js";
import { formatMinor, parseMajor } from "../money.js";
import { BillStore } from "../store.js";
import { buildControlExample } from "../fixtures/control-example.js";
import type { Item } from "../types.js";

function catchDomain(fn: () => unknown): DomainError {
  try {
    fn();
  } catch (err) {
    if (err instanceof DomainError) return err;
    throw err;
  }
  throw new Error("expected a DomainError");
}

const people = ["p1", "p2", "p3", "p4"];
const item = (split: Item["split"], price: number): Item => ({ id: "i1", title: "X", price, paidById: "p1", split });

describe("rounding (§6 edge case a)", () => {
  it("100 equal on three people → 33.34 / 33.33 / 33.33", () => {
    const result = allocate(item({ type: "equal", personIds: ["p1", "p2", "p3"] }, parseMajor("100")), people);
    assert.deepEqual(result, { p1: 3334, p2: 3333, p3: 3333 });
    assert.deepEqual(Object.values(result).map((n) => formatMinor(n)), ["33.34", "33.33", "33.33"]);
  });
});

describe("exact mismatch (§6 edge case b)", () => {
  it("250 + 250 + 90 on price 600 → EXACT_MISMATCH, not distributed 10.00", () => {
    const err = catchDomain(() =>
      allocate(item({ type: "exact", amounts: { p1: 25000, p2: 25000, p3: 9000 } }, 60000), people),
    );
    assert.equal(err.code, "EXACT_MISMATCH");
    assert.deepEqual(err.details, { itemId: "i1", expected: 60000, actual: 59000, diff: 1000 });
    assert.equal(formatMinor(err.details.diff as number), "10.00");
    assert.match(err.message, /не распределено 10\.00/);
  });

  it("over-allocation reports the overshoot", () => {
    const err = catchDomain(() => allocate(item({ type: "exact", amounts: { p1: 40000, p2: 30000 } }, 60000), people));
    assert.equal(err.details.diff, -10000);
    assert.match(err.message, /перебор на 100\.00/);
  });

  it("store keeps the previous split when update_item is rejected", () => {
    const store = new BillStore();
    const { billId, ids } = buildControlExample(store);
    const before = store.getBill(billId);
    const versionBefore = store.version;
    assert.throws(
      () =>
        store.updateItem(billId, ids.items.wine, {
          split: { type: "exact", amounts: { [ids.people.anya]: 25000, [ids.people.borya]: 25000, [ids.people.vika]: 9000 } },
        }),
      DomainError,
    );
    assert.deepEqual(store.getBill(billId), before);
    assert.equal(store.version, versionBefore);
  });
});

describe("remove referenced person (§6 edge case c)", () => {
  it("removing Гена fails with Еда and Чаевые only", () => {
    const store = new BillStore();
    const { billId, ids } = buildControlExample(store);
    const err = catchDomain(() => store.removePerson(billId, ids.people.gena));
    assert.equal(err.code, "PERSON_REFERENCED");
    const items = err.details.items as Array<{ title: string; role: string }>;
    assert.deepEqual(items.map((i) => i.title), ["Еда", "Чаевые"]);
    assert.ok(items.every((i) => i.role === "participant"));
    assert.match(err.message, /Еда/);
    assert.match(err.message, /Чаевые/);
  });

  it("removing a payer lists the payer role; an unreferenced person can be removed", () => {
    const store = new BillStore();
    const { billId, ids } = buildControlExample(store);
    const err = catchDomain(() => store.removePerson(billId, ids.people.vika));
    assert.ok((err.details.items as Array<{ role: string }>).some((i) => i.role === "payer"));
    const dima = store.addPerson(billId, "Дима");
    store.removePerson(billId, dima.id);
    assert.deepEqual(store.getBill(billId).people.map((p) => p.name), ["Аня", "Боря", "Вика", "Гена"]);
  });
});

describe("remainder order (rule 4)", () => {
  it("follows bill.people order, not split key order", () => {
    assert.deepEqual(allocate(item({ type: "equal", personIds: ["p3", "p1", "p2"] }, 100), people), { p1: 34, p2: 33, p3: 33 });
    assert.deepEqual(allocate(item({ type: "shares", weights: { p3: 1, p2: 1, p1: 1 } }, 100), people), { p1: 34, p2: 33, p3: 33 });
  });

  it("shares remainder goes to the first participants in people order", () => {
    // 1001 split 1:1:1 → floors 333 each, remainder 2 → p1, p2
    assert.deepEqual(allocate(item({ type: "shares", weights: { p2: 1, p4: 1, p1: 1 } }, 1001), people), {
      p1: 334,
      p2: 334,
      p4: 333,
    });
  });
});

describe("new person (rule 5, second sentence)", () => {
  it("addPerson after items exist changes no allocation", () => {
    const store = new BillStore();
    const { billId } = buildControlExample(store);
    const before = store.getSummary(billId).allocations;
    store.addPerson(billId, "Дима");
    const after = store.getSummary(billId);
    assert.deepEqual(after.allocations, before);
    const dima = after.people.find((p) => p.name === "Дима")!;
    assert.deepEqual([dima.owes, dima.paid, dima.balance], [0, 0, 0]);
  });

  it("a new item without a split is equal on all current people (rule 1)", () => {
    const store = new BillStore();
    const { billId, ids } = buildControlExample(store);
    const dima = store.addPerson(billId, "Дима");
    const created = store.addItem(billId, { title: "Десерт", price: 50000, paidById: ids.people.gena });
    assert.deepEqual(created.split, { type: "equal", personIds: [...Object.values(ids.people), dima.id] });
  });
});

describe("weights validation", () => {
  for (const w of [0, 1.5, -1]) {
    it(`rejects weight ${w}`, () => {
      const err = catchDomain(() => allocate(item({ type: "shares", weights: { p1: 2, p2: w } }, 1000), people));
      assert.equal(err.code, "INVALID_WEIGHT");
    });
  }

  it("rejects unknown people and empty splits", () => {
    assert.equal(catchDomain(() => allocate(item({ type: "equal", personIds: ["p9"] }, 100), people)).code, "UNKNOWN_PERSON");
    assert.equal(catchDomain(() => allocate(item({ type: "equal", personIds: [] }, 100), people)).code, "EMPTY_SPLIT");
  });
});

describe("parseMajor / formatMinor", () => {
  const valid: Array<[string | number, number]> = [
    ["1200", 120000],
    ["33.5", 3350],
    ["33,50", 3350],
    ["1 200.00", 120000],
    ["0", 0],
    ["0.01", 1],
    [" 723,67 ", 72367],
    [12.5, 1250],
    [1200, 120000],
  ];
  for (const [input, expected] of valid) {
    it(`parseMajor(${JSON.stringify(input)}) = ${expected}`, () => assert.equal(parseMajor(input), expected));
  }

  for (const input of ["12.345", "-5", "abc", "", "1.2.3", "NaN"]) {
    it(`parseMajor(${JSON.stringify(input)}) rejects`, () => assert.equal(catchDomain(() => parseMajor(input)).code, "INVALID_AMOUNT"));
  }

  it("rejects numeric inputs with more than 2 decimals or negatives", () => {
    assert.equal(catchDomain(() => parseMajor(1.005)).code, "INVALID_AMOUNT");
    assert.equal(catchDomain(() => parseMajor(-1)).code, "INVALID_AMOUNT");
  });

  it("formats with U+2212 minus and optional plus sign", () => {
    assert.equal(formatMinor(-40500), "−405.00");
    assert.equal(formatMinor(38500, { sign: true }), "+385.00");
    assert.equal(formatMinor(0, { sign: true }), "0.00");
    assert.equal(formatMinor(5), "0.05");
  });
});

describe("names", () => {
  it("rejects duplicate names case-insensitively", () => {
    const store = new BillStore();
    const { billId, ids } = buildControlExample(store);
    assert.equal(catchDomain(() => store.addPerson(billId, "аня")).code, "DUPLICATE_NAME");
    assert.equal(catchDomain(() => store.renamePerson(billId, ids.people.borya, "Вика")).code, "DUPLICATE_NAME");
    assert.equal(store.renamePerson(billId, ids.people.borya, "Борис").name, "Борис");
  });
});
