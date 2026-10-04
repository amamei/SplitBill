import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isEditableTarget, matchShortcut, type ShortcutKey } from "../shortcuts";

const key = (k: Partial<ShortcutKey>): ShortcutKey => ({
  key: "",
  code: "",
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  altKey: false,
  isComposing: false,
  ...k,
});

describe("matchShortcut", () => {
  it("maps Escape everywhere, even while typing", () => {
    assert.equal(matchShortcut(key({ key: "Escape" }), true), "closeOverlays");
  });

  it("maps Ctrl+Shift+D and Cmd+Shift+D, by key or by physical code", () => {
    assert.equal(matchShortcut(key({ key: "D", code: "KeyD", ctrlKey: true, shiftKey: true }), false), "toggleDebug");
    assert.equal(matchShortcut(key({ key: "D", code: "KeyD", metaKey: true, shiftKey: true }), true), "toggleDebug");
    assert.equal(matchShortcut(key({ key: "В", code: "KeyD", ctrlKey: true, shiftKey: true }), false), "toggleDebug");
  });

  it("does not treat plain or Shift-less D as debug", () => {
    assert.equal(matchShortcut(key({ key: "d", code: "KeyD", ctrlKey: true }), false), null);
    assert.equal(matchShortcut(key({ key: "d", code: "KeyD" }), false), null);
  });

  it("maps Alt+1 / Alt+2 including macOS symbols", () => {
    assert.equal(matchShortcut(key({ key: "1", code: "Digit1", altKey: true }), false), "showChat");
    assert.equal(matchShortcut(key({ key: "™", code: "Digit2", altKey: true }), false), "showBill");
    assert.equal(matchShortcut(key({ key: "1", code: "Digit1", altKey: true, ctrlKey: true }), false), null);
  });

  it("maps / only outside editable fields", () => {
    assert.equal(matchShortcut(key({ key: "/", code: "Slash" }), false), "focusComposer");
    assert.equal(matchShortcut(key({ key: "/", code: "Slash" }), true), null);
    assert.equal(matchShortcut(key({ key: "/", code: "Slash", ctrlKey: true }), false), null);
  });

  it("ignores everything during IME composition", () => {
    assert.equal(matchShortcut(key({ key: "Escape", isComposing: true }), true), null);
    assert.equal(matchShortcut(key({ key: "/", isComposing: true }), false), null);
  });
});

describe("isEditableTarget", () => {
  it("recognises form fields and contenteditable", () => {
    assert.equal(isEditableTarget({ tagName: "TEXTAREA" } as unknown as EventTarget), true);
    assert.equal(isEditableTarget({ tagName: "INPUT" } as unknown as EventTarget), true);
    assert.equal(isEditableTarget({ tagName: "DIV", isContentEditable: true } as unknown as EventTarget), true);
    assert.equal(isEditableTarget({ tagName: "BUTTON", isContentEditable: false } as unknown as EventTarget), false);
    assert.equal(isEditableTarget(null), false);
  });
});
