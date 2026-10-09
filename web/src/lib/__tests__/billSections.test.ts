import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { sectionOf } from "../billSections";

describe("sectionOf", () => {
  it("maps the layout guide's Card titles", () => {
    assert.equal(sectionOf("Участники"), "people");
    assert.equal(sectionOf("Позиции"), "items");
    assert.equal(sectionOf("Редактор позиции"), "editor");
    assert.equal(sectionOf("Итог"), "summary");
  });

  it("tolerates case, whitespace and close variants", () => {
    assert.equal(sectionOf("  участники счёта "), "people");
    assert.equal(sectionOf("Позиция"), "items");
    assert.equal(sectionOf("РЕДАКТОР"), "editor");
    assert.equal(sectionOf("Итого"), "summary");
  });

  it("does not take the editor for the items list", () => {
    assert.equal(sectionOf("Редактор позиции"), "editor");
  });

  it("ignores other headings", () => {
    assert.equal(sectionOf("Кто кому должен"), undefined);
    assert.equal(sectionOf(""), undefined);
  });
});
