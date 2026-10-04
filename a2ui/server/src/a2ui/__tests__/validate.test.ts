import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateComponents, validateEnvelope, type ValidationResult } from "../validate.js";
import { CATALOG_ID, createSurface, deleteSurface, surfaceTheme, updateComponents, updateDataModel } from "../envelopes.js";

const examplesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "spec", "v0_9", "examples");
const examples = fs.readdirSync(examplesDir).map((f) => ({ ...JSON.parse(fs.readFileSync(path.join(examplesDir, f), "utf8")), file: f }));

function errorsOf(result: ValidationResult): string {
  assert.equal(result.ok, false, "expected validation to fail");
  return result.ok ? "" : result.errors.map((e) => `${e.path}: ${e.message}`).join("\n");
}

const tree = () => [
  { id: "root", component: "Column", children: ["title", "list"] },
  { id: "title", component: "Text", text: "Счёт", variant: "h2" },
  { id: "list", component: "List", children: { path: "/items", componentId: "row" } },
  { id: "row", component: "Row", children: ["row_title", "row_btn"] },
  { id: "row_title", component: "Text", text: { path: "title" } },
  { id: "row_btn", component: "Button", child: "row_btn_label", action: { event: { name: "select_item", context: { itemId: { path: "id" } } } } },
  { id: "row_btn_label", component: "Text", text: "Выбрать" },
];

describe("vendored upstream examples", () => {
  for (const example of examples) {
    it(`${example.file}: every message validates`, () => {
      for (const msg of example.messages) assert.deepEqual(validateEnvelope(msg), { ok: true });
    });
  }

  it("full component trees of single-shot examples pass topology checks", () => {
    for (const name of ["09_login-form.json", "13_coffee-order.json", "34_child-list-template.json"]) {
      const example = examples.find((e) => e.file === name)!;
      const components = example.messages.flatMap((m: { updateComponents?: { components: unknown[] } }) => m.updateComponents?.components ?? []);
      assert.deepEqual(validateComponents(components), { ok: true }, name);
    }
  });
});

describe("our envelopes", () => {
  it("builders produce valid v0.9 envelopes", () => {
    const envelopes = [createSurface("bill"), updateComponents("bill", tree()), updateDataModel("bill", { items: [] }), updateDataModel("bill", "x", "/editor/title"), deleteSurface("bill")];
    for (const e of envelopes) assert.deepEqual(validateEnvelope(e), { ok: true });
    assert.equal((envelopes[0] as { createSurface: { catalogId: string } }).createSurface.catalogId, CATALOG_ID);
  });

  it("createSurface with the bill and chart themes is valid", () => {
    for (const id of ["bill", "chart-1"]) {
      const e = createSurface(id, { theme: surfaceTheme(id) });
      assert.deepEqual(validateEnvelope(e), { ok: true }, id);
    }
    assert.deepEqual(surfaceTheme("bill"), { primaryColor: "#2f6f5e", agentDisplayName: "Split Bill" });
    assert.deepEqual(surfaceTheme("chart-1"), { primaryColor: "#2f6f5e" });
  });

  it("a valid tree with a template passes", () => {
    assert.deepEqual(validateComponents(tree()), { ok: true });
  });
});

describe("rejections with readable errors", () => {
  it("missing version", () => {
    const { version: _v, ...rest } = createSurface("bill") as Record<string, unknown>;
    assert.match(errorsOf(validateEnvelope(rest)), /version must be "v0\.9"/);
  });

  it("missing root", () => {
    assert.match(errorsOf(validateComponents(tree().filter((c) => c.id !== "root"))), /id "root"/);
  });

  it("dangling child id", () => {
    const t = tree();
    t[0] = { id: "root", component: "Column", children: ["title", "list", "ghost"] };
    assert.match(errorsOf(validateComponents(t)), /references missing component "ghost"/);
  });

  it("duplicate id", () => {
    assert.match(errorsOf(validateComponents([...tree(), { id: "title", component: "Text", text: "dup" }])), /duplicate id "title"/);
  });

  it("orphan component", () => {
    assert.match(errorsOf(validateComponents([...tree(), { id: "lost", component: "Text", text: "?" }])), /not reachable from "root": lost/);
  });

  it('unknown component "Chart"', () => {
    const t = tree();
    t[1] = { id: "title", component: "Chart", text: "x" } as never;
    assert.match(errorsOf(validateComponents(t)), /unknown component "Chart"; allowed: Text/);
  });

  it("createSurface carrying components (v1.0 shape)", () => {
    const msg = { version: "v0.9", createSurface: { surfaceId: "s", catalogId: CATALOG_ID, components: tree() } };
    assert.match(errorsOf(validateEnvelope(msg)), /unknown property "components"/);
  });

  it("checks written as {call,args,message} instead of {condition,message}", () => {
    const t = [
      { id: "root", component: "TextField", label: "Имя", value: { path: "/draft/name" }, checks: [{ call: "required", args: { value: { path: "/draft/name" } }, message: "Нужно имя" }] },
    ];
    const text = errorsOf(validateComponents(t));
    assert.match(text, /missing required property "condition"/);
    assert.match(text, /unknown property "call"/);
  });

  it("bad binding shape names the allowed shapes", () => {
    const t = [{ id: "root", component: "Text", text: { pth: "/x" } }];
    assert.match(errorsOf(validateComponents(t)), /does not match any allowed shape/);
  });

  it("Button without action, unknown property", () => {
    const t = [
      { id: "root", component: "Button", child: "l", onClick: "x" },
      { id: "l", component: "Text", text: "ok" },
    ];
    const text = errorsOf(validateComponents(t));
    assert.match(text, /missing required property "action"/);
    assert.match(text, /unknown property "onClick"/);
  });

  it("empty event name", () => {
    const t = [
      { id: "root", component: "Button", child: "l", action: { event: { name: " " } } },
      { id: "l", component: "Text", text: "ok" },
    ];
    assert.match(errorsOf(validateComponents(t)), /event name must be a non-empty string/);
  });
});
