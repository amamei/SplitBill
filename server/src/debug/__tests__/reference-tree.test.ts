import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateComponents } from "../../a2ui/validate.js";
import { KNOWN_ACTIONS } from "../../agent/actions.js";
import { REFERENCE_BILL_TREE } from "../reference-tree.js";

describe("reference bill tree (prompt layout contract)", () => {
  it("is a valid A2UI v0.9 tree", () => {
    assert.deepEqual(validateComponents(REFERENCE_BILL_TREE, { surfaceId: "bill" }), { ok: true });
  });

  it("uses every server-handled action", () => {
    const names = new Set(
      REFERENCE_BILL_TREE.flatMap((c) => {
        const event = (c.action as { event?: { name: string } } | undefined)?.event;
        return event ? [event.name] : [];
      }),
    );
    for (const name of KNOWN_ACTIONS) assert.ok(names.has(name), name);
  });
});

describe("reference bill tree follows the layout guide", () => {
  const byId = new Map(REFERENCE_BILL_TREE.map((c) => [c.id, c]));
  const templateRoots = REFERENCE_BILL_TREE.flatMap((c) => {
    const children = c.children as { componentId?: string } | undefined;
    return children && !Array.isArray(children) && children.componentId ? [children.componentId] : [];
  });

  function descendants(id: string): string[] {
    const c = byId.get(id);
    if (!c) return [];
    const kids = Array.isArray(c.children) ? (c.children as string[]) : [];
    const child = typeof c.child === "string" ? [c.child] : [];
    return [id, ...[...kids, ...child].flatMap(descendants)];
  }

  it("no Row inside a list template has more than 4 children", () => {
    for (const root of templateRoots) {
      for (const id of descendants(root)) {
        const c = byId.get(id)!;
        if (c.component === "Row") assert.ok((c.children as string[]).length <= 4, `${id} has ${(c.children as string[]).length} children`);
      }
    }
  });

  it("every card starts with an h3 title and has at most one primary button", () => {
    for (const card of REFERENCE_BILL_TREE.filter((c) => c.component === "Card")) {
      const col = byId.get(card.child as string)!;
      const first = byId.get((col.children as string[])[0]!)!;
      assert.equal(first.component, "Text");
      assert.equal(first.variant, "h3", card.id);
      const primaries = descendants(card.id).filter((id) => byId.get(id)!.variant === "primary");
      assert.ok(primaries.length <= 1, `${card.id}: ${primaries.join(", ")}`);
    }
  });

  it("binds every hint path", () => {
    const paths = new Set(REFERENCE_BILL_TREE.map((c) => (c.text as { path?: string } | undefined)?.path).filter(Boolean));
    for (const p of ["/hints/people", "/hints/items", "/hints/editor", "/hints/transfers"]) assert.ok(paths.has(p), p);
  });
});
