// TZ §6 control example, entered in major units (×100 → minor), built through the store API.
// Production-importable: the system prompt embeds a projection of this bill.
import { parseMajor } from "../money.js";
import type { BillStore } from "../store.js";

export interface ControlExampleIds {
  people: { anya: string; borya: string; vika: string; gena: string };
  items: { food: string; hookah: string; wine: string; tips: string };
}

export const CONTROL_EXAMPLE_TEXT =
  "Были Аня, Боря, Вика, Гена. Еда 1200 — платил Боря, поровну на всех. " +
  "Кальяны 800 — платила Аня, доли: Аня 2, Боря 1, Вика 1. " +
  "Вино 600 — платила Аня, суммы: Аня 250, Боря 250, Вика 100. " +
  "Чаевые 260 — платила Вика, поровну на всех.";

export function buildControlExample(store: BillStore): { billId: string; ids: ControlExampleIds } {
  const bill = store.createBill("Bermuda", "MDL", ["Аня", "Боря", "Вика", "Гена"], [
    { title: "Еда", price: parseMajor("1200"), paidById: "Боря" },
    {
      title: "Кальяны",
      price: parseMajor("800"),
      paidById: "Аня",
      split: { type: "shares", weights: { Аня: 2, Боря: 1, Вика: 1 } },
    },
    {
      title: "Вино",
      price: parseMajor("600"),
      paidById: "Аня",
      split: { type: "exact", amounts: { Аня: parseMajor("250"), Боря: parseMajor("250"), Вика: parseMajor("100") } },
    },
    { title: "Чаевые", price: parseMajor("260"), paidById: "Вика" },
  ]);
  const [anya, borya, vika, gena] = bill.people.map((p) => p.id);
  const [food, hookah, wine, tips] = bill.items.map((i) => i.id);
  return { billId: bill.id, ids: { people: { anya, borya, vika, gena }, items: { food, hookah, wine, tips } } };
}
