import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ToolError } from "@anthropic-ai/sdk/lib/tools/ToolError";
import { Session } from "../session.js";
import { buildTools } from "../tools.js";
import type { A2uiEnvelope } from "../../a2ui/envelopes.js";


function setup() {
  const session = new Session("t");
  const sent: A2uiEnvelope[] = [];
  session.subscribe((event, data) => event === "a2ui" && sent.push(data as A2uiEnvelope));
  const tools = Object.fromEntries(buildTools(session).map((t) => [t.name, t]));
  const call = async (name: string, input: unknown) => JSON.parse(String(await tools[name].run(tools[name].parse(input) as never)));
  const callError = async (name: string, input: unknown) => {
    try {
      await tools[name].run(tools[name].parse(input) as never);
    } catch (err) {
      assert.ok(err instanceof ToolError, `expected ToolError, got ${err}`);
      return JSON.parse(String(err.content));
    }
    throw new Error("expected the tool to fail");
  };
  return { session, sent, call, callError, types: () => sent.map((e) => Object.keys(e).find((k) => k !== "version")) };
}

const CONTROL_BILL = {
  title: "Bermuda",
  people: ["Аня", "Боря", "Вика", "Гена"],
  items: [
    { title: "Еда", price: "1200", paidBy: "Боря" },
    { title: "Кальяны", price: "800", paidBy: "Аня", split: { type: "shares", weights: { Аня: 2, Боря: 1, Вика: 1 } } },
    { title: "Вино", price: "600", paidBy: "аня", split: { type: "exact", amounts: { Аня: "250", Боря: "250", Вика: "100" } } },
    { title: "Чаевые", price: "260", paidBy: "Вика", split: { type: "equal" } },
  ],
};

const TREE = [
  { id: "root", component: "Column", children: ["title", "rows"] },
  { id: "title", component: "Text", text: { path: "/bill/title" }, variant: "h2" },
  { id: "rows", component: "List", children: { componentId: "row", path: "/summary/rows" } },
  { id: "row", component: "Text", text: { path: "balanceText" } },
];

describe("domain tools", () => {
  it("create_bill (major units) + get_summary reproduce TZ §6", async () => {
    const { call, session } = setup();
    const created = await call("create_bill", CONTROL_BILL);
    assert.equal(created.ok, true);
    const summary = await call("get_summary", {});
    assert.deepEqual(
      summary.bill.balances.map((b: { name: string; balance: string }) => `${b.name} ${b.balance}`),
      ["Аня +385.00", "Боря +385.00", "Вика −405.00", "Гена −365.00"],
    );
    assert.equal(summary.bill.transfers.length, 3);
    assert.equal(session.modelSeenVersion, session.store.version);
  });

  it("domain errors come back as ToolError with code and «Ошибка»", async () => {
    const { call, callError } = setup();
    await call("create_bill", CONTROL_BILL);
    const err = await callError("update_item", { item: "Вино", patch: { split: { type: "exact", amounts: { Аня: "250", Боря: "250", Вика: "90" } } } });
    assert.equal(err.error.code, "EXACT_MISMATCH");
    assert.match(err.error.message, /^Ошибка: .*не распределено 10\.00/);
    const removed = await callError("remove_person", { person: "Гена" });
    assert.deepEqual(removed.error.details.items.map((i: { title: string }) => i.title), ["Еда", "Чаевые"]);
  });

  it("tools before create_bill fail with NO_BILL", async () => {
    const { callError } = setup();
    assert.equal((await callError("get_summary", {})).error.code, "NO_BILL");
  });
});

describe("render_surface", () => {
  it("an invalid tree returns the error JSON and emits nothing", async () => {
    const { call, callError, sent } = setup();
    await call("create_bill", CONTROL_BILL);
    const err = await callError("render_surface", { surfaceId: "bill", components: [{ id: "root", component: "Chart" }] });
    assert.equal(err.error.code, "A2UI_INVALID");
    assert.match(JSON.stringify(err.error.details), /unknown component \\"Chart\\"/);
    assert.equal(sent.length, 0);
  });

  it("a valid tree emits createSurface + updateComponents + updateDataModel(/)", async () => {
    const { call, types, sent, session } = setup();
    await call("create_bill", CONTROL_BILL);
    assert.equal(sent.length, 0, "no data push before the surface exists");
    const result = await call("render_surface", { surfaceId: "bill", components: TREE });
    assert.deepEqual(result, { ok: true, surfaceId: "bill", rendered: 4 });
    assert.deepEqual(types(), ["createSurface", "updateComponents", "updateDataModel"]);
    const data = sent[2] as { updateDataModel: { path: string; value: { bill: { title: string } } } };
    assert.equal(data.updateDataModel.path, "/");
    assert.equal(data.updateDataModel.value.bill.title, "Bermuda");
    assert.ok(session.surfaces.has("bill"));
  });

  it("re-rendering an existing surface deletes it first", async () => {
    const { call, types } = setup();
    await call("create_bill", CONTROL_BILL);
    await call("render_surface", { surfaceId: "bill", components: TREE });
    await call("render_surface", { surfaceId: "bill", components: TREE });
    assert.deepEqual(types().slice(3), ["deleteSurface", "createSurface", "updateComponents", "updateDataModel"]);
  });

  it("S6: update_item after render emits only diffed updateDataModel patches", async () => {
    const { call, sent, types } = setup();
    await call("create_bill", CONTROL_BILL);
    await call("render_surface", { surfaceId: "bill", components: TREE });
    const before = sent.length;
    await call("update_item", { item: "Кальяны", patch: { split: { type: "shares", weights: { Аня: 2, Боря: 1, Вика: 1, Гена: 1 } } } });
    const after = sent.slice(before) as Array<{ updateDataModel?: { path: string; value: unknown } }>;
    assert.ok(after.length >= 1);
    assert.ok(types().slice(before).every((t) => t === "updateDataModel"));
    assert.ok(after.every((e) => e.updateDataModel!.path !== "/"));
    const summary = after.find((e) => e.updateDataModel!.path === "/summary")!.updateDataModel!.value as { rows: Array<{ balanceText: string }> };
    assert.deepEqual(summary.rows.map((r) => r.balanceText), ["+465.00", "+425.00", "−365.00", "−525.00"]);
  });

  it("a non-bill surface uses the model's data", async () => {
    const { call, sent } = setup();
    await call("render_surface", {
      surfaceId: "chart-1",
      components: [{ id: "root", component: "Text", text: { path: "/title" } }],
      data: { title: "Кто сколько потратил" },
    });
    assert.deepEqual((sent[2] as { updateDataModel: { value: unknown } }).updateDataModel.value, { title: "Кто сколько потратил" });
  });

  it("bill before create_bill is rejected", async () => {
    const { callError } = setup();
    assert.equal((await callError("render_surface", { surfaceId: "bill", components: TREE })).error.code, "NO_BILL");
  });
});
