// Minimal updateDataModel patches between two view models. /editor, /draft and /hints are diffed
// per field so a server push never overwrites inputs the user is editing but has not saved
// (A2UI inputs live only in the client data model until an action fires).
import { createScope } from "../log.js";
import type { BillViewModel } from "./view-model.js";

const logger = createScope("projector.diff");

export type VmPatch = { path: string; value: unknown };

const WHOLE_KEYS = ["bill", "people", "items", "summary", "errors"] as const;
const FIELD_KEYS = ["draft", "editor", "hints"] as const;

export function diffViewModel(prev: BillViewModel | undefined, next: BillViewModel): VmPatch[] {
  if (!prev) {
    logger.debug("full", { paths: ["/"] });
    return [{ path: "/", value: next }];
  }
  const patches: VmPatch[] = [];
  for (const key of WHOLE_KEYS) {
    if (!deepEqual(prev[key], next[key])) patches.push({ path: `/${key}`, value: next[key] });
  }
  for (const key of FIELD_KEYS) {
    const a = prev[key] as Record<string, unknown>;
    const b = next[key] as Record<string, unknown>;
    if (key === "editor" && (a.itemId !== b.itemId || a.splitType !== b.splitType)) {
      patches.push({ path: "/editor", value: b });
      continue;
    }
    for (const field of Object.keys(b)) {
      if (!deepEqual(a[field], b[field])) patches.push({ path: `/${key}/${field}`, value: b[field] });
    }
  }
  logger.debug("patches", { paths: patches.map((p) => p.path) });
  return patches;
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const bArr = b as unknown[];
    return a.length === bArr.length && a.every((v, i) => deepEqual(v, bArr[i]));
  }
  const ak = Object.keys(a as object);
  const bk = Object.keys(b as object);
  if (ak.length !== bk.length) return false;
  return ak.every((k) => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}
