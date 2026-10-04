import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { parseFlag, readPref, setPrefsStorage, writePref, type KeyValueStorage } from "../prefs";

function memoryStorage(): KeyValueStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
}

const throwing: KeyValueStorage = {
  getItem() {
    throw new Error("SecurityError");
  },
  setItem() {
    throw new Error("QuotaExceededError");
  },
};

describe("prefs", () => {
  afterEach(() => setPrefsStorage(undefined));

  it("round-trips a value", () => {
    setPrefsStorage(memoryStorage());
    assert.equal(writePref("a2ui-debug", "1"), true);
    assert.equal(readPref("a2ui-debug", false, parseFlag), true);
  });

  it("returns the fallback for a missing key", () => {
    setPrefsStorage(memoryStorage());
    assert.equal(readPref("a2ui-debug-open", false, parseFlag), false);
  });

  it("returns the fallback for an invalid stored value", () => {
    const s = memoryStorage();
    s.data.set("a2ui-debug", "yes please");
    setPrefsStorage(s);
    assert.equal(readPref("a2ui-debug", false, parseFlag), false);
  });

  it("survives a storage that throws", () => {
    setPrefsStorage(throwing);
    assert.equal(readPref("a2ui-theme", "system", (r) => r), "system");
    assert.equal(writePref("a2ui-theme", "dark"), false);
  });

  it("survives no storage at all", () => {
    setPrefsStorage(null);
    assert.equal(readPref("a2ui-debug", true, parseFlag), true);
    assert.equal(writePref("a2ui-debug", "0"), false);
  });

  it("parseFlag accepts only 1 and 0", () => {
    assert.equal(parseFlag("1"), true);
    assert.equal(parseFlag("0"), false);
    assert.equal(parseFlag("true"), undefined);
  });
});
