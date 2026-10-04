// UI actions → domain calls, with no model round trip (S2–S5). Each handled action
// re-projects the bill and returns only updateDataModel patches for what changed.
import type { ActionPayload } from "./action-types.js";
import { createScope } from "../log.js";
import { updateDataModel, type A2uiEnvelope } from "../a2ui/envelopes.js";
import { DomainError } from "../domain/errors.js";
import { formatMinor, parseMajor } from "../domain/money.js";
import type { Split, SplitType } from "../domain/types.js";
import { diffViewModel } from "../projector/diff.js";
import type { BillViewModel, EditorVm } from "../projector/view-model.js";
import type { Session } from "./session.js";

const logger = createScope("agent.actions");

export type DispatchResult = { kind: "handled"; envelopes: A2uiEnvelope[] } | { kind: "forward"; userMessage: string };

/** Spec `a2uiClientDataModel`: `{version, surfaces: {<surfaceId>: <data model>}}`. */
export type ClientDataModel = { version?: string; surfaces?: Record<string, unknown> };

export const KNOWN_ACTIONS = [
  "add_person",
  "rename_person",
  "remove_person",
  "add_item",
  "select_item",
  "remove_item",
  "set_split_type",
  "set_payer",
  "save_item",
  "fix_item",
] as const;

type Handler = (ctx: ActionCtx) => void;

interface ActionCtx {
  session: Session;
  billId: string;
  /** Resolve an input: the action context first, then the attached client data model. */
  pick: (key: string, pointer: string) => unknown;
  /** Record what the client showed for a path, so the diff resets it (e.g. clearing a draft). */
  clientSaw: (mutate: (vm: BillViewModel) => void) => void;
}

const handlers: Record<(typeof KNOWN_ACTIONS)[number], Handler> = {
  add_person({ session, billId, pick, clientSaw }) {
    const name = str(pick("name", "/draft/personName"));
    clientSaw((vm) => (vm.draft.personName = name));
    session.store.addPerson(billId, name);
  },

  rename_person({ session, billId, pick, clientSaw }) {
    const personId = str(pick("personId", ""));
    const name = str(pick("name", ""));
    clientSaw((vm) => {
      const row = vm.people.find((p) => p.id === personId);
      if (row) row.name = name;
    });
    session.store.renamePerson(billId, personId, name);
  },

  remove_person({ session, billId, pick }) {
    const personId = str(pick("personId", ""));
    try {
      session.store.removePerson(billId, personId);
    } catch (err) {
      if (err instanceof DomainError && err.code === "PERSON_REFERENCED") {
        const seen = new Set<string>();
        const items = (err.details.items as Array<{ id: string; title: string }>)
          .filter((i) => !seen.has(i.id) && seen.add(i.id))
          .map((i) => ({ itemId: i.id, title: i.title }));
        session.ui.errors = { ...session.ui.errors, removePerson: { message: err.message, items } };
        throw new KeepUiErrors(err);
      }
      throw err;
    }
  },

  add_item({ session, billId, pick, clientSaw }) {
    const title = str(pick("title", "/draft/itemTitle"));
    const priceText = str(pick("price", "/draft/itemPrice"));
    clientSaw((vm) => {
      vm.draft.itemTitle = title;
      vm.draft.itemPrice = priceText;
    });
    const bill = session.store.getBill(billId);
    const payer = bill.people[0];
    if (!payer) throw new DomainError("UNKNOWN_PERSON", "Сначала добавьте участника", {});
    const item = session.store.addItem(billId, { title, price: parseMajor(priceText), paidById: payer.id });
    selectItem(session, item.id);
  },

  select_item({ session, pick }) {
    selectItem(session, str(pick("itemId", "")));
  },

  fix_item({ session, pick }) {
    selectItem(session, str(pick("itemId", "")));
  },

  remove_item({ session, billId, pick }) {
    const itemId = str(pick("itemId", ""));
    session.store.removeItem(billId, itemId);
    if (session.ui.selectedItemId === itemId || !session.ui.selectedItemId) {
      selectItem(session, session.store.getBill(billId).items[0]?.id);
    }
  },

  set_split_type({ session, billId, pick }) {
    const type = str(pick("type", "")) as SplitType;
    if (!["equal", "exact", "shares"].includes(type)) {
      throw new DomainError("INVALID_AMOUNT", `Неизвестный способ деления: ${type}`, { type });
    }
    const item = selectedItem(session, billId);
    session.ui.pendingSplitType = item.split.type === type ? undefined : { itemId: item.id, type };
    session.ui.editorError = undefined;
  },

  set_payer({ session, billId, pick }) {
    const personId = str(pick("personId", ""));
    const item = selectedItem(session, billId);
    session.store.updateItem(billId, item.id, { paidById: personId });
  },

  save_item({ session, billId, pick, clientSaw }) {
    const editor = (pick("editor", "/editor") ?? {}) as Partial<EditorVm>;
    const itemId = editor.itemId || session.ui.selectedItemId || selectedItem(session, billId).id;
    const typed = { title: editor.title, priceText: editor.priceText, equalRows: editor.equalRows, exactRows: editor.exactRows, sharesRows: editor.sharesRows };
    clientSaw((vm) => {
      for (const [k, v] of Object.entries(typed)) if (v !== undefined) (vm.editor as Record<string, unknown>)[k] = v;
    });
    try {
      const split = splitFromEditor(editor, session.store.getBill(billId).items.find((i) => i.id === itemId)?.split.type);
      session.store.updateItem(billId, itemId, {
        ...(editor.title !== undefined ? { title: str(editor.title).trim() } : {}),
        ...(editor.priceText !== undefined ? { price: parseMajor(str(editor.priceText)) } : {}),
        ...(split ? { split } : {}),
      });
      session.ui.pendingSplitType = undefined;
      session.ui.editorError = undefined;
    } catch (err) {
      if (!(err instanceof DomainError)) throw err;
      const diff = err.code === "EXACT_MISMATCH" ? (err.details.diff as number) : 0;
      const remainingText = diff > 0 ? `Не распределено ${formatMinor(diff)}` : diff < 0 ? `Перебор на ${formatMinor(-diff)}` : "";
      session.ui.editorError = { message: err.message, remainingText };
      // Keep what the user typed so they can fix it; only the error fields change.
      throw new KeepTypedEditor(err, typed);
    }
  },
};

/** remove_person failure: the error lives in ui.errors.removePerson, do not clear it. */
class KeepUiErrors extends Error {
  constructor(readonly cause: DomainError) {
    super(cause.message);
  }
}

/** save_item failure: error shown in the editor; typed inputs survive the push. */
class KeepTypedEditor extends Error {
  constructor(
    readonly cause: DomainError,
    readonly typed: Partial<EditorVm>,
  ) {
    super(cause.message);
  }
}

export function dispatchAction(session: Session, action: ActionPayload, clientDataModel?: ClientDataModel): DispatchResult {
  logger.info("dispatch", { session: session.id, name: action.name, context: action.context });
  const handler = (handlers as Record<string, Handler | undefined>)[action.name];
  if (!handler) {
    const userMessage = `[UI action] ${action.name} ${JSON.stringify(action.context ?? {})}`;
    logger.info("forward", { session: session.id, name: action.name });
    return { kind: "forward", userMessage };
  }
  if (!session.billId) {
    logger.warn("no bill yet", { session: session.id, name: action.name });
    return { kind: "handled", envelopes: [] };
  }

  const billId = session.billId;
  const clientBill = clientDataModel?.surfaces?.[action.surfaceId || "bill"] ?? clientDataModel?.surfaces?.bill;
  const context = (action.context ?? {}) as Record<string, unknown>;
  const pick = (key: string, pointer: string) => (key in context ? context[key] : pointer ? getPointer(clientBill, pointer) : undefined);
  const base: BillViewModel | undefined = session.lastVm ? structuredClone(session.lastVm) : undefined;
  const clientSaw = (mutate: (vm: BillViewModel) => void) => base && mutate(base);

  let keepTyped: Partial<EditorVm> | undefined;
  try {
    handler({ session, billId, pick, clientSaw });
    // Any successful action dismisses earlier action errors.
    session.ui.errors = undefined;
  } catch (err) {
    if (err instanceof KeepUiErrors) {
      logger.warn("domain error", { name: action.name, code: err.cause.code });
    } else if (err instanceof KeepTypedEditor) {
      logger.warn("domain error", { name: action.name, code: err.cause.code, details: err.cause.details });
      keepTyped = err.typed;
    } else if (err instanceof DomainError) {
      logger.warn("domain error", { name: action.name, code: err.code, details: err.details });
      session.ui.errors = { ...session.ui.errors, general: { message: err.message } };
    } else {
      logger.error("action failed", { name: action.name, err: err instanceof Error ? err.stack : String(err) });
      session.ui.errors = { ...session.ui.errors, general: { message: "Не удалось выполнить действие" } };
    }
  }

  const next = session.project();
  if (keepTyped) {
    for (const [k, v] of Object.entries(keepTyped)) if (v !== undefined) (next.editor as Record<string, unknown>)[k] = v;
  }
  const envelopes = diffViewModel(base, next).map((d) => updateDataModel("bill", d.value, d.path));
  session.lastVm = next;
  return { kind: "handled", envelopes };
}

function selectItem(session: Session, itemId: string | undefined): void {
  session.ui.selectedItemId = itemId;
  session.ui.pendingSplitType = undefined;
  session.ui.editorError = undefined;
}

function selectedItem(session: Session, billId: string) {
  const items = session.store.getBill(billId).items;
  const item = items.find((i) => i.id === session.ui.selectedItemId) ?? items[0];
  if (!item) throw new DomainError("NOT_FOUND", "В счёте нет позиций", {});
  return item;
}

/** Editor rows → Split. Zero / empty values mean "not participating". */
function splitFromEditor(editor: Partial<EditorVm>, storedType: SplitType | undefined): Split | undefined {
  const type = (editor.splitType || storedType) as SplitType | undefined;
  if (type === "equal" && editor.equalRows) {
    const personIds = editor.equalRows.filter((r) => r.included === true).map((r) => r.personId);
    if (personIds.length === 0) throw new DomainError("EMPTY_SPLIT", "Отметьте хотя бы одного участника", {});
    return { type, personIds };
  }
  if (type === "exact" && editor.exactRows) {
    const amounts: Record<string, number> = {};
    for (const row of editor.exactRows) {
      const raw = str(row.amountText).trim();
      if (!raw) continue;
      const amount = parseMajor(raw);
      if (amount > 0) amounts[row.personId] = amount;
    }
    return { type, amounts };
  }
  if (type === "shares" && editor.sharesRows) {
    const weights: Record<string, number> = {};
    for (const row of editor.sharesRows) {
      const raw = str(row.weightText).trim();
      if (!raw || raw === "0") continue;
      const weight = Number(raw.replace(",", "."));
      if (!Number.isInteger(weight) || weight <= 0) {
        throw new DomainError("INVALID_WEIGHT", `Доля должна быть целым положительным числом (${row.name}: ${raw})`, { personId: row.personId, weight: raw });
      }
      weights[row.personId] = weight;
    }
    if (Object.keys(weights).length === 0) throw new DomainError("EMPTY_SPLIT", "Укажите долю хотя бы одному участнику", {});
    return { type, weights };
  }
  return undefined;
}

function str(v: unknown): string {
  if (v === undefined || v === null) return "";
  return typeof v === "string" ? v : String(v);
}

function getPointer(root: unknown, pointer: string): unknown {
  if (!pointer || pointer === "/") return root;
  let node: unknown = root;
  for (const part of pointer.split("/").slice(1)) {
    if (node === null || typeof node !== "object") return undefined;
    node = (node as Record<string, unknown>)[part.replace(/~1/g, "/").replace(/~0/g, "~")];
  }
  return node;
}
