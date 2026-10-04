import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ACTION_CONTRACT, buildSystemPrompt, promptVersion } from "../prompt.js";
import { KNOWN_ACTIONS } from "../actions.js";
import { COMPONENT_NAMES } from "../../a2ui/validate.js";

describe("buildSystemPrompt", () => {
  const prompt = buildSystemPrompt();

  it("contains every action name the server dispatches", () => {
    assert.deepEqual(ACTION_CONTRACT.map((a) => a.name).sort(), [...KNOWN_ACTIONS].sort());
    for (const name of KNOWN_ACTIONS) assert.ok(prompt.includes(`| ${name} |`), name);
  });

  it("contains every catalog component name and the schema block", () => {
    for (const name of COMPONENT_NAMES) assert.ok(prompt.includes(`"${name}"`), name);
    assert.ok(prompt.includes("---BEGIN A2UI JSON SCHEMA---") && prompt.includes("---END A2UI JSON SCHEMA---"));
    assert.ok(prompt.includes("---BEGIN 34_child-list-template---"));
  });

  it("embeds the view-model schema and the control-example projection", () => {
    assert.ok(prompt.includes("sharesRows"));
    assert.ok(prompt.includes('"title":"Bermuda"'));
    assert.ok(prompt.includes("доли: Аня 2, Боря 1, Вика 1"));
  });

  it("is deterministic (prompt caching) and has no timestamps", () => {
    assert.equal(buildSystemPrompt(), prompt);
    assert.match(promptVersion(), /^[0-9a-f]{10}$/);
    assert.doesNotMatch(prompt, /20\d\d-\d\d-\d\dT/);
  });

  it("stays well under the ~30k token budget (≈ 4 chars/token upper bound)", () => {
    assert.ok(prompt.length < 120_000, `prompt is ${prompt.length} chars`);
  });
});
