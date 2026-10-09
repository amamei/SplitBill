// Data model of the `bill` surface. Produced only by the projector; the model-authored
// component tree binds to these paths. All money is preformatted text (no formatCurrency),
// and there is no conditional visibility in A2UI v0.9: inactive lists are simply empty.
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

const text = z.string();

export const BillViewModelSchema = z
  .object({
    bill: z.object({ title: text, currency: text, totalText: text }).describe("Bill header"),
    people: z.array(z.object({ id: text, name: text })).describe("Participants; name is editable (rename_person)"),
    draft: z
      .object({ personName: text, itemTitle: text, itemPrice: text })
      .describe("Inputs for add_person / add_item; the client edits them, the server clears them"),
    items: z
      .array(
        z.object({
          id: text,
          title: text,
          priceText: text,
          payerName: text,
          splitText: text.describe("Human-readable split, e.g. «доли: Аня 2, Боря 1»"),
          isSelectedText: text.describe("«▶» for the item open in the editor, otherwise empty"),
        }),
      )
      .describe("Bill items in order"),
    editor: z
      .object({
        itemId: text,
        title: text,
        priceText: text,
        payerId: text,
        payerName: text,
        splitType: z.enum(["equal", "exact", "shares", ""]),
        splitTypeText: text,
        payerOptions: z.array(z.object({ id: text, name: text, markText: text.describe("«●» for the current payer") })),
        equalRows: z.array(z.object({ personId: text, name: text, included: z.boolean(), shareText: text })),
        exactRows: z.array(z.object({ personId: text, name: text, amountText: text })),
        sharesRows: z.array(z.object({ personId: text, name: text, weightText: text, shareText: text })),
        remainingText: text.describe("e.g. «Не распределено 10.00» after a failed exact save"),
        error: text,
      })
      .describe("The selected item. Exactly one of equalRows/exactRows/sharesRows is non-empty (the active split type)"),
    summary: z.object({
      rows: z.array(z.object({ personId: text, name: text, owesText: text, paidText: text, balanceText: text })),
      transfers: z.array(z.object({ fromId: text, toId: text, text: text, amountText: text })),
    }),
    hints: z
      .object({
        people: text.describe("«Добавьте участников…» while there are fewer than two people, else empty"),
        items: text.describe("«Пока нет позиций…» while the bill has no items, else empty"),
        editor: text.describe("«Выберите позицию…» while no item is open in the editor, else empty"),
        transfers: text.describe("«Все в расчёте.» when there are items but nobody owes anybody, else empty"),
      })
      .describe("Empty-state hints filled by the server; bind each to a caption Text at the top of its section (empty string renders nothing)"),
    errors: z.object({
      general: z
        .object({ message: text })
        .describe("Last failed UI action outside the editor (add_person, add_item, rename_person…); empty when none"),
      removePerson: z.object({
        message: text,
        items: z.array(z.object({ itemId: text, title: text })).describe("Items blocking the removal; empty when there is no error"),
      }),
    }),
  })
  .strict();

export type BillViewModel = z.infer<typeof BillViewModelSchema>;
export type EditorVm = BillViewModel["editor"];
export type DraftVm = BillViewModel["draft"];
export type HintsVm = BillViewModel["hints"];

export function billViewModelJsonSchema(): Record<string, unknown> {
  const schema = zodToJsonSchema(BillViewModelSchema, { $refStrategy: "none" }) as Record<string, unknown>;
  delete schema.$schema;
  return schema;
}
