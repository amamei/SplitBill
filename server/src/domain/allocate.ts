// TZ §4 rules 1–4: how one item's price is split between people. Integer arithmetic only.
import { createScope } from "../log.js";
import { DomainError } from "./errors.js";
import { formatMinor } from "./money.js";
import type { Item, PersonId } from "./types.js";

const logger = createScope("domain.allocate");

export type Allocation = Record<PersonId, number>;

/**
 * Splits `item.price` between the split participants.
 * `peopleOrder` is `bill.people` ids in order: it decides who gets the indivisible
 * remainder (1 minor unit each, rule 4) and the key order of the result.
 */
export function allocate(item: Item, peopleOrder: PersonId[]): Allocation {
  try {
    const result = allocateUnlogged(item, peopleOrder);
    logger.debug("ok", { itemId: item.id, type: item.split.type, price: item.price, result });
    return result;
  } catch (err) {
    if (err instanceof DomainError) logger.warn("rejected", { itemId: item.id, code: err.code, details: err.details });
    throw err;
  }
}

function allocateUnlogged(item: Item, peopleOrder: PersonId[]): Allocation {
  const known = new Set(peopleOrder);
  const split = item.split;
  const keys =
    split.type === "equal" ? split.personIds : split.type === "exact" ? Object.keys(split.amounts) : Object.keys(split.weights);
  for (const id of keys) {
    if (!known.has(id)) {
      throw new DomainError("UNKNOWN_PERSON", `Неизвестный участник: ${id}`, { itemId: item.id, personId: id });
    }
  }

  switch (split.type) {
    case "equal": {
      const participants = peopleOrder.filter((id) => split.personIds.includes(id));
      if (participants.length === 0) {
        throw new DomainError("EMPTY_SPLIT", `В позиции «${item.title}» никто не участвует в делении`, { itemId: item.id });
      }
      const base = Math.floor(item.price / participants.length);
      const remainder = item.price - base * participants.length;
      return withRemainder(participants, () => base, remainder);
    }

    case "exact": {
      const participants = peopleOrder.filter((id) => id in split.amounts);
      let actual = 0;
      for (const id of participants) {
        const amount = split.amounts[id];
        if (!Number.isInteger(amount) || amount < 0) {
          throw new DomainError("INVALID_AMOUNT", `Некорректная сумма для участника ${id}`, { itemId: item.id, personId: id, amount });
        }
        actual += amount;
      }
      if (actual !== item.price) {
        const diff = item.price - actual;
        const message =
          diff > 0
            ? `Сумма долей ${formatMinor(actual)} не равна цене ${formatMinor(item.price)}: не распределено ${formatMinor(diff)}`
            : `Сумма долей ${formatMinor(actual)} не равна цене ${formatMinor(item.price)}: перебор на ${formatMinor(-diff)}`;
        throw new DomainError("EXACT_MISMATCH", message, { itemId: item.id, expected: item.price, actual, diff });
      }
      const result: Allocation = {};
      for (const id of participants) result[id] = split.amounts[id];
      return result;
    }

    case "shares": {
      const participants = peopleOrder.filter((id) => id in split.weights);
      if (participants.length === 0) {
        throw new DomainError("EMPTY_SPLIT", `В позиции «${item.title}» никто не участвует в делении`, { itemId: item.id });
      }
      let total = 0;
      for (const id of participants) {
        const w = split.weights[id];
        if (!Number.isInteger(w) || w <= 0) {
          throw new DomainError("INVALID_WEIGHT", `Доля должна быть целым положительным числом (участник ${id}: ${w})`, {
            itemId: item.id,
            personId: id,
            weight: w,
          });
        }
        total += w;
      }
      if (!Number.isSafeInteger(item.price * total)) {
        throw new Error(`allocate: price × weights overflows (${item.price} × ${total})`);
      }
      const floors = new Map(participants.map((id) => [id, Math.floor((item.price * split.weights[id]) / total)]));
      const assigned = [...floors.values()].reduce((a, b) => a + b, 0);
      return withRemainder(participants, (id) => floors.get(id)!, item.price - assigned);
    }
  }
}

/** Base amount per participant + 1 minor unit to the first `remainder` participants (rule 4). */
function withRemainder(participants: PersonId[], base: (id: PersonId) => number, remainder: number): Allocation {
  const result: Allocation = {};
  participants.forEach((id, index) => {
    result[id] = base(id) + (index < remainder ? 1 : 0);
  });
  return result;
}
