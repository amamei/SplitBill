// Bill → BillViewModel. Pure; all money formatted here, never in the model or the UI.
import { createScope } from "../log.js";
import { allocate, type Allocation } from "../domain/allocate.js";
import { formatMinor } from "../domain/money.js";
import { summarize } from "../domain/summary.js";
import type { Bill, Item, Person, Split, SplitType } from "../domain/types.js";
import type { BillViewModel, DraftVm, EditorVm } from "./view-model.js";

const logger = createScope("projector.projectBill");

export interface UiErrors {
  general?: { message: string };
  removePerson?: { message: string; items: Array<{ itemId: string; title: string }> };
}

export interface UiState {
  selectedItemId?: string;
  /** Split type picked in the editor but not saved yet (set_split_type). */
  pendingSplitType?: { itemId: string; type: SplitType };
  draft?: DraftVm;
  errors?: UiErrors;
  editorError?: { message: string; remainingText: string };
}

export const EMPTY_DRAFT: DraftVm = { personName: "", itemTitle: "", itemPrice: "" };

const SPLIT_TYPE_TEXT: Record<SplitType, string> = { equal: "Поровну", exact: "Суммы", shares: "Доли" };

export function projectBill(bill: Bill, ui: UiState = {}): BillViewModel {
  const nameOf = new Map(bill.people.map((p) => [p.id, p.name]));
  const order = bill.people.map((p) => p.id);
  const summary = summarize(bill);
  const selected = bill.items.find((i) => i.id === ui.selectedItemId) ?? bill.items[0];

  const vm: BillViewModel = {
    bill: { title: bill.title, currency: bill.currency, totalText: formatMinor(summary.total) },
    people: bill.people.map((p) => ({ id: p.id, name: p.name })),
    draft: { ...EMPTY_DRAFT, ...ui.draft },
    items: bill.items.map((item) => ({
      id: item.id,
      title: item.title,
      priceText: formatMinor(item.price),
      payerName: nameOf.get(item.paidById) ?? "?",
      splitText: splitText(item.split, bill.people),
      isSelectedText: item.id === selected?.id ? "▶" : "",
    })),
    editor: selected ? projectEditor(bill, selected, order, ui) : emptyEditor(),
    summary: {
      rows: summary.people.map((p) => ({
        personId: p.personId,
        name: p.name,
        owesText: formatMinor(p.owes),
        paidText: formatMinor(p.paid),
        balanceText: formatMinor(p.balance, { sign: true }),
      })),
      transfers: summary.transfers.map((t) => ({
        fromId: t.fromId,
        toId: t.toId,
        text: `${nameOf.get(t.fromId)} → ${nameOf.get(t.toId)} ${formatMinor(t.amount)}`,
        amountText: formatMinor(t.amount),
      })),
    },
    errors: {
      general: ui.errors?.general ?? { message: "" },
      removePerson: ui.errors?.removePerson ?? { message: "", items: [] },
    },
  };
  logger.debug("projected", { billId: bill.id, items: bill.items.length, selected: selected?.id, splitType: vm.editor.splitType });
  return vm;
}

function projectEditor(bill: Bill, item: Item, order: string[], ui: UiState): EditorVm {
  const pending = ui.pendingSplitType?.itemId === item.id ? ui.pendingSplitType.type : undefined;
  const type: SplitType = pending ?? item.split.type;
  // A pending type starts from defaults (rule table: equal = everyone, exact = zeros, shares = 1 each).
  const split: Split = pending && pending !== item.split.type ? defaultSplit(pending, order) : item.split;
  let shares: Allocation = {};
  try {
    shares = allocate({ ...item, split }, order);
  } catch {
    shares = {}; // an exact default of zeros does not sum to the price; show no shares
  }
  const payerName = bill.people.find((p) => p.id === item.paidById)?.name ?? "?";
  const shareText = (id: string) => formatMinor(shares[id] ?? 0);

  return {
    itemId: item.id,
    title: item.title,
    priceText: formatMinor(item.price),
    payerId: item.paidById,
    payerName,
    splitType: type,
    splitTypeText: SPLIT_TYPE_TEXT[type],
    payerOptions: bill.people.map((p) => ({ id: p.id, name: p.name, markText: p.id === item.paidById ? "●" : "" })),
    equalRows:
      split.type === "equal"
        ? bill.people.map((p) => ({ personId: p.id, name: p.name, included: split.personIds.includes(p.id), shareText: shareText(p.id) }))
        : [],
    exactRows:
      split.type === "exact"
        ? bill.people.map((p) => ({ personId: p.id, name: p.name, amountText: formatMinor(split.amounts[p.id] ?? 0) }))
        : [],
    sharesRows:
      split.type === "shares"
        ? bill.people.map((p) => ({
            personId: p.id,
            name: p.name,
            weightText: String(split.weights[p.id] ?? 0),
            shareText: shareText(p.id),
          }))
        : [],
    remainingText: ui.editorError?.remainingText ?? "",
    error: ui.editorError?.message ?? "",
  };
}

function emptyEditor(): EditorVm {
  return {
    itemId: "",
    title: "",
    priceText: "",
    payerId: "",
    payerName: "",
    splitType: "",
    splitTypeText: "",
    payerOptions: [],
    equalRows: [],
    exactRows: [],
    sharesRows: [],
    remainingText: "",
    error: "",
  };
}

export function defaultSplit(type: SplitType, order: string[]): Split {
  if (type === "equal") return { type, personIds: [...order] };
  if (type === "exact") return { type, amounts: Object.fromEntries(order.map((id) => [id, 0])) };
  return { type, weights: Object.fromEntries(order.map((id) => [id, 1])) };
}

/** «поровну: все» / «поровну: Аня, Боря» / «суммы: Аня 250.00, …» / «доли: Аня 2, …». No Markdown syntax. */
export function splitText(split: Split, people: Person[]): string {
  const ordered = people.filter((p) =>
    split.type === "equal" ? split.personIds.includes(p.id) : split.type === "exact" ? p.id in split.amounts : p.id in split.weights,
  );
  if (split.type === "equal") {
    return ordered.length === people.length ? "поровну: все" : `поровну: ${ordered.map((p) => p.name).join(", ")}`;
  }
  if (split.type === "exact") return `суммы: ${ordered.map((p) => `${p.name} ${formatMinor(split.amounts[p.id])}`).join(", ")}`;
  return `доли: ${ordered.map((p) => `${p.name} ${split.weights[p.id]}`).join(", ")}`;
}
