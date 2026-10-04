// In-memory bills (TZ §3: process memory only). Every mutation validates the resulting
// state through `allocate` before committing, so a stored bill is always consistent.
import { createScope } from "../log.js";
import { allocate } from "./allocate.js";
import { DomainError } from "./errors.js";
import { summarize, type Summary } from "./summary.js";
import type { Bill, Item, ItemId, ItemPatch, NewItem, Person, PersonId, Split } from "./types.js";

const logger = createScope("domain.store");

export interface PersonReference {
  id: ItemId;
  title: string;
  role: "payer" | "participant";
}

interface BillState {
  bill: Bill;
  nextPersonNo: number;
  nextItemNo: number;
}

const clone = <T>(value: T): T => structuredClone(value);

export class BillStore {
  private readonly bills = new Map<string, BillState>();
  private nextBillNo = 1;
  /** Bumped on every successful mutation (lets the agent detect UI-side changes). */
  version = 0;

  /**
   * Creates a bill atomically. Items may reference people by id (`p1`…) or by exact name,
   * since callers cannot know the generated ids in advance.
   */
  createBill(title: string, currency = "MDL", people: string[] = [], items: NewItem[] = []): Bill {
    logger.info("createBill", { title, currency, people, items: items.length });
    const state: BillState = {
      bill: { id: `b${this.nextBillNo}`, title, currency, people: [], items: [] },
      nextPersonNo: 1,
      nextItemNo: 1,
    };
    for (const name of people) this.addPersonTo(state, name);
    for (const raw of items) {
      const item = this.resolveItemRefs(state.bill, raw);
      this.addItemTo(state, item);
    }
    this.nextBillNo += 1;
    this.bills.set(state.bill.id, state);
    this.commit(state.bill.id);
    return clone(state.bill);
  }

  getBill(billId: string): Bill {
    return clone(this.state(billId).bill);
  }

  addPerson(billId: string, name: string): Person {
    logger.info("addPerson", { billId, name });
    const person = this.addPersonTo(this.state(billId), name);
    this.commit(billId);
    return clone(person);
  }

  renamePerson(billId: string, personId: PersonId, name: string): Person {
    logger.info("renamePerson", { billId, personId, name });
    const bill = this.state(billId).bill;
    const person = this.person(bill, personId);
    const trimmed = this.validName(bill, name, personId);
    person.name = trimmed;
    this.commit(billId);
    return clone(person);
  }

  /** Rule 5: blocked while the person pays for or takes part in any item. */
  removePerson(billId: string, personId: PersonId): void {
    logger.info("removePerson", { billId, personId });
    const bill = this.state(billId).bill;
    const person = this.person(bill, personId);
    const refs = this.referencesTo(bill, personId);
    if (refs.length > 0) {
      const titles = [...new Set(refs.map((r) => `«${r.title}»`))].join(", ");
      throw new DomainError("PERSON_REFERENCED", `Нельзя удалить участника «${person.name}»: он участвует в позициях ${titles}`, {
        personId,
        name: person.name,
        items: refs,
      });
    }
    bill.people = bill.people.filter((p) => p.id !== personId);
    this.commit(billId);
  }

  addItem(billId: string, item: NewItem): Item {
    logger.info("addItem", { billId, item });
    const state = this.state(billId);
    const created = this.addItemTo(state, item);
    this.commit(billId);
    return clone(created);
  }

  updateItem(billId: string, itemId: ItemId, patch: ItemPatch): Item {
    logger.info("updateItem", { billId, itemId, patch });
    const bill = this.state(billId).bill;
    const index = bill.items.findIndex((i) => i.id === itemId);
    if (index < 0) throw new DomainError("NOT_FOUND", `Позиция ${itemId} не найдена`, { itemId });
    const next: Item = { ...bill.items[index], ...clone(patch) };
    this.validateItem(bill, next);
    bill.items[index] = next;
    this.commit(billId);
    return clone(next);
  }

  removeItem(billId: string, itemId: ItemId): void {
    logger.info("removeItem", { billId, itemId });
    const bill = this.state(billId).bill;
    if (!bill.items.some((i) => i.id === itemId)) {
      throw new DomainError("NOT_FOUND", `Позиция ${itemId} не найдена`, { itemId });
    }
    bill.items = bill.items.filter((i) => i.id !== itemId);
    this.commit(billId);
  }

  getSummary(billId: string): Summary {
    return summarize(this.state(billId).bill);
  }

  referencesTo(bill: Bill, personId: PersonId): PersonReference[] {
    const refs: PersonReference[] = [];
    for (const item of bill.items) {
      if (item.paidById === personId) refs.push({ id: item.id, title: item.title, role: "payer" });
      else if (splitIncludes(item.split, personId)) refs.push({ id: item.id, title: item.title, role: "participant" });
    }
    return refs;
  }

  // --- internals -------------------------------------------------------------

  private state(billId: string): BillState {
    const state = this.bills.get(billId);
    if (!state) throw new DomainError("NOT_FOUND", `Счёт ${billId} не найден`, { billId });
    return state;
  }

  private person(bill: Bill, personId: PersonId): Person {
    const person = bill.people.find((p) => p.id === personId);
    if (!person) throw new DomainError("UNKNOWN_PERSON", `Участник ${personId} не найден`, { personId });
    return person;
  }

  private validName(bill: Bill, name: string, exceptId?: PersonId): string {
    const trimmed = name.trim();
    if (!trimmed) throw new DomainError("INVALID_NAME", "Имя не может быть пустым", { name });
    const clash = bill.people.find((p) => p.id !== exceptId && p.name.toLowerCase() === trimmed.toLowerCase());
    if (clash) throw new DomainError("DUPLICATE_NAME", `Участник «${trimmed}» уже есть`, { name: trimmed, personId: clash.id });
    return trimmed;
  }

  private addPersonTo(state: BillState, name: string): Person {
    const person = { id: `p${state.nextPersonNo}`, name: this.validName(state.bill, name) };
    state.nextPersonNo += 1;
    // Rule 5, second sentence: a new person never joins existing items.
    state.bill.people.push(person);
    return person;
  }

  private addItemTo(state: BillState, input: NewItem): Item {
    const bill = state.bill;
    const item: Item = {
      id: `i${state.nextItemNo}`,
      title: input.title.trim(),
      price: input.price,
      paidById: input.paidById,
      split: input.split ? clone(input.split) : { type: "equal", personIds: bill.people.map((p) => p.id) },
    };
    this.validateItem(bill, item);
    state.nextItemNo += 1;
    bill.items.push(item);
    return item;
  }

  private validateItem(bill: Bill, item: Item): void {
    if (!item.title) throw new DomainError("INVALID_NAME", "Название позиции не может быть пустым", { itemId: item.id });
    if (!Number.isSafeInteger(item.price) || item.price < 0) {
      throw new DomainError("INVALID_AMOUNT", `Некорректная цена позиции «${item.title}»`, { itemId: item.id, price: item.price });
    }
    this.person(bill, item.paidById);
    allocate(item, bill.people.map((p) => p.id));
  }

  /** createBill only: map person names to ids in payer and split keys. */
  private resolveItemRefs(bill: Bill, item: NewItem): NewItem {
    const ref = (key: string): PersonId => {
      const byId = bill.people.find((p) => p.id === key);
      if (byId) return byId.id;
      const byName = bill.people.find((p) => p.name.toLowerCase() === key.trim().toLowerCase());
      if (byName) return byName.id;
      throw new DomainError("UNKNOWN_PERSON", `Участник «${key}» не найден`, { name: key });
    };
    const mapKeys = (rec: Record<string, number>) => Object.fromEntries(Object.entries(rec).map(([k, v]) => [ref(k), v]));
    let split: Split | undefined;
    if (item.split?.type === "equal") split = { type: "equal", personIds: item.split.personIds.map(ref) };
    else if (item.split?.type === "exact") split = { type: "exact", amounts: mapKeys(item.split.amounts) };
    else if (item.split?.type === "shares") split = { type: "shares", weights: mapKeys(item.split.weights) };
    return { ...item, paidById: ref(item.paidById), split };
  }

  private commit(billId: string): void {
    this.version += 1;
    const bill = this.state(billId).bill;
    logger.debug("committed", { billId, version: this.version, people: bill.people.length, items: bill.items.length });
  }
}

function splitIncludes(split: Split, personId: PersonId): boolean {
  if (split.type === "equal") return split.personIds.includes(personId);
  if (split.type === "exact") return personId in split.amounts;
  return personId in split.weights;
}
