// TZ §4 domain contract. All money values are integer minor units (bani).
import { z } from "zod";

export type PersonId = string;
export type ItemId = string;

export interface Person {
  id: PersonId;
  name: string;
}

export type Split =
  | { type: "equal"; personIds: PersonId[] }
  | { type: "exact"; amounts: Record<PersonId, number> }
  | { type: "shares"; weights: Record<PersonId, number> };

export type SplitType = Split["type"];

export interface Item {
  id: ItemId;
  title: string;
  /** Integer minor units. */
  price: number;
  paidById: PersonId;
  split: Split;
}

export interface Bill {
  id: string;
  title: string;
  currency: string;
  people: Person[];
  items: Item[];
}

/** Input for `addItem`; no split means `equal` on all current people (rule 1). */
export interface NewItem {
  title: string;
  price: number;
  paidById: PersonId;
  split?: Split;
}

export type ItemPatch = Partial<Pick<Item, "title" | "price" | "paidById" | "split">>;

const minor = z.number().int().nonnegative();

export const SplitSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("equal"), personIds: z.array(z.string()).min(1) }),
  z.object({ type: z.literal("exact"), amounts: z.record(z.string(), minor) }),
  z.object({ type: z.literal("shares"), weights: z.record(z.string(), z.number()) }),
]);

export const ItemPatchSchema = z
  .object({
    title: z.string().min(1).optional(),
    price: minor.optional(),
    paidById: z.string().optional(),
    split: SplitSchema.optional(),
  })
  .strict();
