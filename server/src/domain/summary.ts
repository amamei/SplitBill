// TZ §4 rule 6: balance = paid − owes; settle with ≤ N−1 transfers.
import { createScope } from "../log.js";
import { allocate, type Allocation } from "./allocate.js";
import type { Bill, ItemId, PersonId } from "./types.js";

const logger = createScope("domain.summary");

export interface PersonSummary {
  personId: PersonId;
  name: string;
  owes: number;
  paid: number;
  balance: number;
}

export interface Transfer {
  fromId: PersonId;
  toId: PersonId;
  amount: number;
}

export interface Summary {
  billId: string;
  currency: string;
  total: number;
  people: PersonSummary[];
  transfers: Transfer[];
  /** Per-item allocation (TZ §6 table columns); persons outside the split are absent. */
  allocations: Record<ItemId, Allocation>;
}

export function summarize(bill: Bill): Summary {
  const order = bill.people.map((p) => p.id);
  const owes = new Map<PersonId, number>(order.map((id) => [id, 0]));
  const paid = new Map<PersonId, number>(order.map((id) => [id, 0]));
  const allocations: Record<ItemId, Allocation> = {};
  let total = 0;

  for (const item of bill.items) {
    const allocation = allocate(item, order);
    allocations[item.id] = allocation;
    for (const [id, amount] of Object.entries(allocation)) owes.set(id, (owes.get(id) ?? 0) + amount);
    paid.set(item.paidById, (paid.get(item.paidById) ?? 0) + item.price);
    total += item.price;
  }

  const people = bill.people.map((p) => {
    const o = owes.get(p.id) ?? 0;
    const pd = paid.get(p.id) ?? 0;
    return { personId: p.id, name: p.name, owes: o, paid: pd, balance: pd - o };
  });
  const transfers = settle(people.map((p) => ({ id: p.personId, balance: p.balance })));
  logger.debug("summarized", { billId: bill.id, total, balances: people.map((p) => [p.name, p.balance]), transfers: transfers.length });
  return { billId: bill.id, currency: bill.currency, total, people, transfers, allocations };
}

/**
 * Greedy: largest debtor pays largest creditor until one side is zero. Every step
 * zeroes at least one balance, so at most N−1 transfers. Ties break by people order
 * (the input order), which keeps the result deterministic.
 */
export function settle(balances: Array<{ id: PersonId; balance: number }>): Transfer[] {
  const rank = new Map(balances.map((b, i) => [b.id, i]));
  const debtors = balances.filter((b) => b.balance < 0).map((b) => ({ id: b.id, left: -b.balance }));
  const creditors = balances.filter((b) => b.balance > 0).map((b) => ({ id: b.id, left: b.balance }));
  const byLeft = (a: { id: string; left: number }, b: { id: string; left: number }) =>
    b.left - a.left || rank.get(a.id)! - rank.get(b.id)!;
  const transfers: Transfer[] = [];

  while (debtors.length > 0 && creditors.length > 0) {
    debtors.sort(byLeft);
    creditors.sort(byLeft);
    const debtor = debtors[0];
    const creditor = creditors[0];
    const amount = Math.min(debtor.left, creditor.left);
    transfers.push({ fromId: debtor.id, toId: creditor.id, amount });
    debtor.left -= amount;
    creditor.left -= amount;
    if (debtor.left === 0) debtors.shift();
    if (creditor.left === 0) creditors.splice(creditors.indexOf(creditor), 1);
  }
  return transfers;
}
