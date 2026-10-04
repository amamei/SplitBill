import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateComponents } from "../../a2ui/validate.js";
import { KNOWN_ACTIONS } from "../../agent/actions.js";
import { REFERENCE_BILL_TREE } from "../reference-tree.js";

describe("reference bill tree (prompt layout contract)", () => {
  it("is a valid A2UI v0.9 tree", () => {
    assert.deepEqual(validateComponents(REFERENCE_BILL_TREE), { ok: true });
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
