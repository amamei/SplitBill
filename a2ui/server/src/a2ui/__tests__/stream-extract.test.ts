import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ComponentStreamExtractor } from "../stream-extract.js";

const input = {
  surfaceId: "bill",
  components: [
    { id: "root", component: "Column", children: ["t", "l"] },
    { id: "t", component: "Text", text: 'Счёт {"не" [объект]} \\ и "кавычки"', variant: "h2" },
    { id: "l", component: "List", children: { componentId: "row", path: "/items" } },
    { id: "row", component: "Button", child: "lbl", action: { event: { name: "select_item", context: { itemId: { path: "id" } } } } },
    { id: "lbl", component: "Text", text: "}]," },
  ],
  data: { nested: [{ components: [{ id: "not-a-component" }] }] },
};
const json = JSON.stringify(input, null, 1);

function run(chunks: string[]) {
  const ids: string[] = [];
  const components: Array<Record<string, unknown>> = [];
  const order: string[] = [];
  const x = new ComponentStreamExtractor({
    onSurfaceId: (id) => {
      ids.push(id);
      order.push(`surface:${id}`);
    },
    onComponent: (c) => {
      components.push(c);
      order.push(`component:${c.id}`);
    },
  });
  for (const c of chunks) x.feed(c);
  return { ids, components, order, x };
}

function splitEvery(text: string, n: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += n) out.push(text.slice(i, i + n));
  return out;
}

describe("ComponentStreamExtractor", () => {
  for (const size of [1, 2, 3, 7, 13, 64, json.length]) {
    it(`emits surfaceId first and components in order (chunk size ${size})`, () => {
      const { ids, components, order, x } = run(splitEvery(json, size));
      assert.deepEqual(ids, ["bill"]);
      assert.equal(order[0], "surface:bill");
      assert.deepEqual(components, input.components);
      assert.equal(x.componentCount, input.components.length);
      assert.deepEqual(x.done(), input);
    });
  }

  it("emits a component as soon as its closing brace arrives", () => {
    const cut = json.indexOf('"id": "t"'); // inside the second component
    assert.ok(cut > 0);
    const { components } = run([json.slice(0, cut)]);
    assert.deepEqual(components.map((c) => c.id), ["root"]);
  });

  it("handles components written before surfaceId", () => {
    const reversed = JSON.stringify({ components: input.components, surfaceId: "chart-1" });
    const { ids, components, order } = run(splitEvery(reversed, 5));
    assert.deepEqual(ids, ["chart-1"]);
    assert.equal(components.length, 5);
    assert.equal(order.at(-1), "surface:chart-1");
  });

  it("ignores nested 'components' keys inside data", () => {
    const { components } = run([json]);
    assert.ok(!components.some((c) => c.id === "not-a-component"));
  });

  it("an invalid JSON tail makes done() throw a readable error", () => {
    const { x } = run([json.slice(0, -10) + "}}]oops"]);
    assert.throws(() => x.done(), /render_surface input is not valid JSON/);
  });
});
