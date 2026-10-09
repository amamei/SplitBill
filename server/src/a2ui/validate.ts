// Validates model-authored A2UI v0.9 components (and whole envelopes) against the vendored
// spec, plus the topology rules JSON Schema cannot express. Errors are condensed so they
// can be fed back to the model for self-repair.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import type { ErrorObject, ValidateFunction } from "ajv";
import { createScope } from "../log.js";

const logger = createScope("a2ui.validate");
const here = path.dirname(fileURLToPath(import.meta.url));
// tsx runs from src/; a tsc build in dist/ does not copy JSON, so fall back to the sources.
const specDir = [path.join(here, "spec", "v0_9"), path.resolve(here, "../../src/a2ui/spec/v0_9")].find((d) => fs.existsSync(d))!;
const readSpec = (name: string) => JSON.parse(fs.readFileSync(path.join(specDir, name), "utf8"));

export const commonTypesSchema = readSpec("common_types.json");
export const catalogSchema = readSpec("catalog.json");
const serverToClientSchema = readSpec("server_to_client.json");
// Project-owned chart components; lives outside spec/ so the vendored files stay verbatim.
export const customComponentsSchema = JSON.parse(fs.readFileSync(path.join(specDir, "..", "..", "custom_components.json"), "utf8"));

const BASIC_NAMES: string[] = Object.keys(catalogSchema.components);
const CUSTOM_NAMES: string[] = Object.keys(customComponentsSchema.components);
export const COMPONENT_NAMES: string[] = [...BASIC_NAMES, ...CUSTOM_NAMES];
const MAX_ERRORS = 12;

export type ValidationError = { path: string; message: string };
export type ValidationResult = { ok: true } | { ok: false; errors: ValidationError[] };

// ajv / ajv-formats are CommonJS; under NodeNext the default import arrives wrapped.
const AjvCtor = ((Ajv2020 as unknown as { default?: unknown }).default ?? Ajv2020) as typeof Ajv2020.default;
const addFormatsFn = ((addFormats as unknown as { default?: unknown }).default ?? addFormats) as unknown as (ajv: unknown) => void;

const ajv = new AjvCtor({ strict: false, allErrors: true });
addFormatsFn(ajv);
ajv.addSchema(commonTypesSchema);
ajv.addSchema(catalogSchema);
// server_to_client.json references a relative "catalog.json"; upstream run_tests.py aliases it the same way.
ajv.addSchema({ ...catalogSchema, $id: "https://a2ui.org/specification/v0_9/catalog.json" });
ajv.addSchema(serverToClientSchema);
ajv.addSchema(customComponentsSchema);

const componentValidators = new Map<string, ValidateFunction>([
  ...BASIC_NAMES.map((name) => [name, ajv.getSchema(`${catalogSchema.$id}#/components/${name}`)!] as const),
  ...CUSTOM_NAMES.map((name) => [name, ajv.getSchema(`${customComponentsSchema.$id}#/components/${name}`)!] as const),
]);
const messageValidators: Record<string, ValidateFunction> = {
  createSurface: ajv.getSchema(`${serverToClientSchema.$id}#/$defs/CreateSurfaceMessage`)!,
  updateComponents: ajv.getSchema(`${serverToClientSchema.$id}#/$defs/UpdateComponentsMessage`)!,
  updateDataModel: ajv.getSchema(`${serverToClientSchema.$id}#/$defs/UpdateDataModelMessage`)!,
  deleteSurface: ajv.getSchema(`${serverToClientSchema.$id}#/$defs/DeleteSurfaceMessage`)!,
};

/** Validates a full envelope; for updateComponents the component errors come from per-type schemas. */
export function validateEnvelope(msg: unknown): ValidationResult {
  if (!isObject(msg)) return fail([{ path: "", message: "envelope must be a JSON object" }]);
  const errors: ValidationError[] = [];
  if (msg.version !== "v0.9" && msg.version !== "v0.9.1") {
    errors.push({ path: "/version", message: `version must be "v0.9" (got ${JSON.stringify(msg.version)})` });
  }
  const ops = Object.keys(msg).filter((k) => k !== "version");
  if (ops.length !== 1 || !(ops[0] in messageValidators)) {
    errors.push({
      path: "",
      message: `envelope must have exactly one of ${Object.keys(messageValidators).join(", ")} (got ${ops.join(", ") || "none"})`,
    });
    return fail(errors);
  }
  const op = ops[0];
  if (op === "updateComponents" && isObject(msg.updateComponents) && Array.isArray(msg.updateComponents.components)) {
    const { components, ...rest } = msg.updateComponents;
    const shell = messageValidators.updateComponents;
    if (!shell({ ...msg, version: "v0.9", updateComponents: { ...rest, components: [{ id: "root", component: "Divider" }] } })) {
      errors.push(...condense(shell.errors));
    }
    // A single envelope may be one step of an incremental build: references can point at
    // components sent later, so only per-component schema + duplicate ids are checked here.
    const result = validateComponents(components, { requireRoot: false, checkReferences: false, prefix: "/updateComponents/components" });
    if (!result.ok) errors.push(...result.errors);
  } else {
    const validator = messageValidators[op];
    if (!validator({ ...msg, version: "v0.9" })) errors.push(...condense(validator.errors));
  }
  if (errors.length > 0) {
    logger.warn("envelope invalid", { op, errors });
    return fail(errors);
  }
  return { ok: true };
}

/**
 * Validates a flat component list: each component against its catalog schema, then topology:
 * unique ids, one `root`, every child reference resolves, every component reachable from root.
 */
export function validateComponents(
  components: unknown,
  opts: { requireRoot?: boolean; checkReferences?: boolean; prefix?: string; surfaceId?: string } = {},
): ValidationResult {
  const { requireRoot = true, checkReferences = true, prefix = "/components", surfaceId } = opts;
  if (!Array.isArray(components) || components.length === 0) {
    return fail([{ path: prefix, message: "components must be a non-empty array" }]);
  }
  const errors: ValidationError[] = [];
  const byId = new Map<string, Record<string, unknown>>();

  components.forEach((c, index) => {
    const at = `${prefix}/${index}`;
    if (!isObject(c)) {
      errors.push({ path: at, message: "component must be an object" });
      return;
    }
    const id = typeof c.id === "string" ? c.id : undefined;
    const label = id ? `${at} (id "${id}")` : at;
    if (!id) errors.push({ path: at, message: 'component needs a string "id"' });
    else if (byId.has(id)) errors.push({ path: label, message: `duplicate id "${id}"` });
    else byId.set(id, c);

    const type = c.component;
    const validator = typeof type === "string" ? componentValidators.get(type) : undefined;
    if (!validator) {
      errors.push({
        path: label,
        message: `unknown component ${JSON.stringify(type)}; allowed: ${COMPONENT_NAMES.join(", ")}`,
      });
      return;
    }
    if (!validator(c)) errors.push(...condense(validator.errors, label));
    const action = c.action as Record<string, unknown> | undefined;
    const event = action && isObject(action.event) ? action.event : undefined;
    if (event && (typeof event.name !== "string" || event.name.trim() === "")) {
      errors.push({ path: `${label}/action/event/name`, message: "event name must be a non-empty string" });
    }
  });

  if (requireRoot && !byId.has("root")) errors.push({ path: prefix, message: 'exactly one component must have id "root"' });

  // References and reachability.
  for (const [id, c] of checkReferences ? byId : new Map<string, Record<string, unknown>>()) {
    for (const { ref, prop } of childRefs(c)) {
      if (!byId.has(ref)) errors.push({ path: `${prefix} (id "${id}")/${prop}`, message: `references missing component "${ref}"` });
    }
  }
  if (checkReferences && byId.has("root")) {
    const reachable = new Set<string>();
    const stack = ["root"];
    while (stack.length > 0) {
      const id = stack.pop()!;
      if (reachable.has(id)) continue;
      reachable.add(id);
      const c = byId.get(id);
      if (c) for (const { ref } of childRefs(c)) stack.push(ref);
    }
    const orphans = [...byId.keys()].filter((id) => !reachable.has(id));
    if (orphans.length > 0) {
      errors.push({ path: prefix, message: `components not reachable from "root": ${orphans.join(", ")}` });
    }
  }

  // One parent per component: a Text that is both a Button's child and a Row's child renders
  // twice (the label shows up beside its own button).
  if (checkReferences) {
    const parents = new Map<string, string[]>();
    for (const [id, c] of byId) {
      for (const { ref } of childRefs(c)) if (byId.has(ref)) parents.set(ref, [...(parents.get(ref) ?? []), id]);
    }
    for (const [ref, from] of parents) {
      if (from.length < 2) continue;
      errors.push({
        path: `${prefix} (id "${ref}")`,
        message: `component "${ref}" is placed by ${from.map((p) => `"${p}"`).join(" and ")}, so it renders ${from.length} times; a component has one parent — keep it under one of them (a Button's label Text belongs only to the Button's "child")`,
      });
    }
  }

  if (checkReferences && surfaceId === "bill") errors.push(...billContractErrors(byId, prefix));

  if (errors.length > 0) {
    const condensed = errors.slice(0, MAX_ERRORS);
    if (errors.length > MAX_ERRORS) condensed.push({ path: prefix, message: `…and ${errors.length - MAX_ERRORS} more errors` });
    logger.warn("components invalid", { surfaceId, count: components.length, errors: condensed });
    return fail(condensed);
  }
  logger.debug("ok", { surfaceId, components: components.length });
  return { ok: true };
}

/**
 * Bill-specific checks the schema cannot express: the payer picker must show who each button
 * is for. A template over /editor/payerOptions bound only to markText renders a row of blank
 * buttons with a single «●».
 */
function billContractErrors(byId: Map<string, Record<string, unknown>>, prefix: string): ValidationError[] {
  const errors: ValidationError[] = [];
  for (const [id, c] of byId) {
    const children = c.children;
    if (!isObject(children) || children.path !== "/editor/payerOptions" || typeof children.componentId !== "string") continue;
    if (!subtree(byId, children.componentId).some((t) => t.component === "Text" && isObject(t.text) && t.text.path === "name")) {
      errors.push({
        path: `${prefix} (id "${id}")/children`,
        message: 'the /editor/payerOptions template must show each person\'s name: make the Button\'s child a Row of two Texts, {"path": "markText"} and {"path": "name"}',
      });
    }
  }
  return errors;
}

/** A component and everything under it (cycle-safe). */
function subtree(byId: Map<string, Record<string, unknown>>, rootId: string): Array<Record<string, unknown>> {
  const seen = new Set<string>();
  const out: Array<Record<string, unknown>> = [];
  const stack = [rootId];
  while (stack.length > 0) {
    const id = stack.pop()!;
    const c = byId.get(id);
    if (!c || seen.has(id)) continue;
    seen.add(id);
    out.push(c);
    for (const { ref } of childRefs(c)) stack.push(ref);
  }
  return out;
}

/** Every component id a component points to, with the property it came from. */
export function childRefs(c: Record<string, unknown>): Array<{ ref: string; prop: string }> {
  const refs: Array<{ ref: string; prop: string }> = [];
  const children = c.children;
  if (Array.isArray(children)) {
    children.forEach((ref, i) => typeof ref === "string" && refs.push({ ref, prop: `children/${i}` }));
  } else if (isObject(children) && typeof children.componentId === "string") {
    refs.push({ ref: children.componentId, prop: "children/componentId" });
  }
  for (const prop of ["child", "trigger", "content"]) {
    if (typeof c[prop] === "string") refs.push({ ref: c[prop] as string, prop });
  }
  if (Array.isArray(c.tabs)) {
    c.tabs.forEach((tab, i) => {
      if (isObject(tab) && typeof tab.child === "string") refs.push({ ref: tab.child, prop: `tabs/${i}/child` });
    });
  }
  return refs;
}

/**
 * Turns raw ajv output into a short list: drops combinator noise (allOf/anyOf/if), keeps a
 * single "does not match" line for a failed oneOf unless a deeper branch explains it, and
 * names unknown properties.
 */
function condense(errors: ErrorObject[] | null | undefined, prefix = ""): ValidationError[] {
  if (!errors) return [];
  const relevant = errors.filter((e) => !["allOf", "anyOf", "if"].includes(e.keyword));
  const oneOfPaths = new Set(relevant.filter((e) => e.keyword === "oneOf").map((e) => e.instancePath));
  const out: ValidationError[] = [];
  const seen = new Set<string>();
  for (const e of relevant) {
    const deeperExplained = relevant.some(
      (d) => d !== e && d.keyword !== "oneOf" && d.instancePath.startsWith(`${e.instancePath}/`),
    );
    if (oneOfPaths.has(e.instancePath) && e.keyword !== "oneOf") continue; // branch noise at the same level
    if (e.keyword === "oneOf" && deeperExplained) continue;
    let message: string;
    if (e.keyword === "unevaluatedProperties" || e.keyword === "additionalProperties") {
      const prop = (e.params as { unevaluatedProperty?: string; additionalProperty?: string }).unevaluatedProperty ??
        (e.params as { additionalProperty?: string }).additionalProperty;
      message = `unknown property "${prop}"`;
    } else if (e.keyword === "oneOf") {
      message = "value does not match any allowed shape (literal, {\"path\": …} binding, or {\"call\": …} function)";
    } else if (e.keyword === "required") {
      message = `missing required property "${(e.params as { missingProperty: string }).missingProperty}"`;
    } else if (e.keyword === "enum") {
      message = `must be one of ${JSON.stringify((e.params as { allowedValues: unknown[] }).allowedValues)}`;
    } else if (e.keyword === "const") {
      message = `must be ${JSON.stringify((e.params as { allowedValue: unknown }).allowedValue)}`;
    } else {
      message = e.message ?? e.keyword;
    }
    const entry = { path: `${prefix}${e.instancePath}`, message };
    const key = `${entry.path}|${entry.message}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(entry);
    }
  }
  return out;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function fail(errors: ValidationError[]): ValidationResult {
  return { ok: false, errors };
}
