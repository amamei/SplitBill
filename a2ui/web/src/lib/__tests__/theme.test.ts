import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { setPrefsStorage } from "../prefs";
import { parseThemePref, readThemePref, resolveTheme } from "../theme";

describe("theme", () => {
  afterEach(() => setPrefsStorage(undefined));

  it("resolves every preference against the OS setting", () => {
    assert.equal(resolveTheme("system", false), "light");
    assert.equal(resolveTheme("system", true), "dark");
    assert.equal(resolveTheme("light", true), "light");
    assert.equal(resolveTheme("dark", false), "dark");
  });

  it("parses only known values", () => {
    assert.equal(parseThemePref("dark"), "dark");
    assert.equal(parseThemePref("sepia"), undefined);
  });

  it("falls back to system when storage throws", () => {
    setPrefsStorage({
      getItem() {
        throw new Error("blocked");
      },
      setItem() {},
    });
    assert.equal(readThemePref(), "system");
  });
});
