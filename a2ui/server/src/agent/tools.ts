// Claude tools bound to one session: the TZ §4 domain tools (money in code, never in the
// model) plus render_surface, the only way the model produces UI.
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { ToolError } from "@anthropic-ai/sdk/lib/tools/ToolError";
import type { BetaToolRunContext } from "@anthropic-ai/sdk/lib/tools/BetaRunnableTool";
import { z } from "zod/v4";
import { createScope } from "../log.js";
import {
  createSurface,
  deleteSurface,
  updateComponents,
  updateDataModel,
  type A2uiComponent,
  type A2uiEnvelope,
} from "../a2ui/envelopes.js";
import { validateComponents } from "../a2ui/validate.js";
import { DomainError } from "../domain/errors.js";
import { formatMinor, parseMajor } from "../domain/money.js";
import type { Bill, Item, NewItem, Person, Split } from "../domain/types.js";
import { diffViewModel } from "../projector/diff.js";
import { splitText } from "../projector/project.js";
import type { Session } from "./session.js";

const logger = createScope("agent.tools");
export const MAX_RENDER_REPAIRS = 3;

// --- input schemas (zod/v4: required by betaZodTool) ---------------------------------

const money = z.string().describe('Major units as a decimal string, e.g. "1200" or "33.50"');
const personRef = z.string().describe("Person name or id (p1, p2…)");
const itemRef = z.string().describe("Item title or id (i1, i2…)");

const SplitInput = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("equal"),
    people: z.array(personRef).optional().describe("Who shares the item equally; omit for everyone"),
  }),
  z.object({
    type: z.literal("exact"),
    amounts: z.record(z.string(), money).describe("Person → amount; must add up to the price"),
  }),
  z.object({
    type: z.literal("shares"),
    weights: z.record(z.string(), z.number().int().positive()).describe("Person → integer weight (e.g. 2, 1, 1)"),
  }),
]);
type SplitInput = z.infer<typeof SplitInput>;

const ItemInput = z.object({
  title: z.string().min(1),
  price: money,
  paidBy: personRef.describe("Who paid for this item"),
  split: SplitInput.optional().describe("Omit for an equal split between everyone"),
});

// --- helpers ---------------------------------------------------------------------------

function requireBill(session: Session): Bill {
  if (!session.billId) throw new ToolError(errorJson("NO_BILL", "Счёта ещё нет: сначала вызовите create_bill"));
  return session.store.getBill(session.billId);
}

function resolvePerson(bill: Bill, ref: string): Person {
  const exact = bill.people.find((p) => p.id === ref || p.name === ref);
  if (exact) return exact;
  const loose = bill.people.filter((p) => p.name.toLowerCase() === ref.trim().toLowerCase());
  if (loose.length === 1) return loose[0];
  if (loose.length > 1) throw new DomainError("AMBIGUOUS_NAME", `Несколько участников с именем «${ref}»`, { ref });
  throw new DomainError("UNKNOWN_PERSON", `Участник «${ref}» не найден. Есть: ${bill.people.map((p) => p.name).join(", ")}`, { ref });
}

function resolveItem(bill: Bill, ref: string): Item {
  const exact = bill.items.find((i) => i.id === ref || i.title === ref);
  if (exact) return exact;
  const loose = bill.items.filter((i) => i.title.toLowerCase() === ref.trim().toLowerCase());
  if (loose.length === 1) return loose[0];
  if (loose.length > 1) throw new DomainError("AMBIGUOUS_NAME", `Несколько позиций «${ref}»`, { ref });
  throw new DomainError("NOT_FOUND", `Позиция «${ref}» не найдена. Есть: ${bill.items.map((i) => i.title).join(", ")}`, { ref });
}

function toSplit(bill: Bill, input: SplitInput): Split {
  const id = (ref: string) => resolvePerson(bill, ref).id;
  if (input.type === "equal") return { type: "equal", personIds: input.people ? input.people.map(id) : bill.people.map((p) => p.id) };
  if (input.type === "exact") {
    return { type: "exact", amounts: Object.fromEntries(Object.entries(input.amounts).map(([k, v]) => [id(k), parseMajor(v)])) };
  }
  return { type: "shares", weights: Object.fromEntries(Object.entries(input.weights).map(([k, v]) => [id(k), v])) };
}

function errorJson(code: string, message: string, details?: unknown): string {
  return JSON.stringify({ ok: false, error: { code, message: `Ошибка: ${message}`, ...(details ? { details } : {}) } });
}

/** Compact bill snapshot for tool results: major-unit strings, names instead of ids. */
function billSnapshot(session: Session): Record<string, unknown> {
  const bill = session.store.getBill(session.billId!);
  const summary = session.store.getSummary(bill.id);
  const name = (id: string) => bill.people.find((p) => p.id === id)?.name ?? id;
  return {
    title: bill.title,
    currency: bill.currency,
    total: formatMinor(summary.total),
    people: bill.people.map((p) => `${p.id} ${p.name}`),
    items: bill.items.map((i) => ({ id: i.id, title: i.title, price: formatMinor(i.price), paidBy: name(i.paidById), split: splitText(i.split, bill.people) })),
    balances: summary.people.map((p) => ({ name: p.name, owes: formatMinor(p.owes), paid: formatMinor(p.paid), balance: formatMinor(p.balance, { sign: true }) })),
    transfers: summary.transfers.map((t) => `${name(t.fromId)} → ${name(t.toId)} ${formatMinor(t.amount)}`),
  };
}

/** Runs a domain mutation; on success pushes the diffed bill data model to the client. */
function domainTool<T>(session: Session, toolName: string, input: T, mutate: (bill: Bill) => void): string {
  logger.debug("call", { session: session.id, tool: toolName, input });
  try {
    mutate(requireBill(session));
  } catch (err) {
    if (err instanceof DomainError) {
      logger.warn("domain error", { tool: toolName, code: err.code, details: err.details });
      session.modelSeenVersion = session.store.version;
      throw new ToolError(errorJson(err.code, err.message, err.details));
    }
    throw err;
  }
  pushBillData(session);
  session.modelSeenVersion = session.store.version;
  const result = JSON.stringify({ ok: true, bill: billSnapshot(session) });
  logger.debug("result", { tool: toolName, bytes: result.length });
  return result;
}

/** After a model-side mutation: patch the rendered bill surface (only changed paths). */
export function pushBillData(session: Session): void {
  if (!session.billId || !session.surfaces.has("bill")) return;
  // A model edit may remove the selected item or change its split; drop stale UI state.
  const bill = session.store.getBill(session.billId);
  if (session.ui.selectedItemId && !bill.items.some((i) => i.id === session.ui.selectedItemId)) session.ui.selectedItemId = undefined;
  session.ui.pendingSplitType = undefined;
  session.ui.editorError = undefined;
  const next = session.project();
  const envelopes = diffViewModel(session.lastVm, next).map((d) => updateDataModel("bill", d.value, d.path));
  session.lastVm = next;
  session.emit(envelopes);
}

// --- render_surface --------------------------------------------------------------------

export interface StreamedRender {
  surfaceId: string;
  /** Components already sent to the client in streamed updateComponents batches. */
  sent: number;
}

const RenderInput = z.object({
  surfaceId: z
    .string()
    .min(1)
    .regex(/^[a-z0-9][a-z0-9_-]*$/, "lowercase id: letters, digits, - and _")
    .describe('"bill" for the main bill UI, a new id (e.g. "chart-1") for any other screen. Write it first.'),
  components: z
    .array(z.record(z.string(), z.unknown()))
    .min(1)
    .describe("A2UI v0.9 components, flat array, root first, parents before children"),
  data: z
    .record(z.string(), z.unknown())
    .optional()
    .describe('Data model for non-bill surfaces (the server provides the "bill" data itself)'),
});

export function renderSurface(session: Session, input: z.infer<typeof RenderInput>, toolUseId?: string): string {
  const { surfaceId, components, data } = input;
  const streamed = toolUseId ? session.streamedRenders.get(toolUseId) : undefined;
  if (toolUseId) session.streamedRenders.delete(toolUseId);
  logger.debug("render_surface", { session: session.id, surfaceId, components: components.length, streamed: streamed?.sent ?? 0 });

  if (surfaceId === "bill" && !session.billId) {
    if (streamed) session.emit([deleteSurface(surfaceId)]);
    throw new ToolError(errorJson("NO_BILL", "Счёта ещё нет: сначала вызовите create_bill, потом render_surface"));
  }
  const result = validateComponents(components, { surfaceId });
  if (!result.ok) {
    if (streamed) session.emit([deleteSurface(surfaceId)]); // drop the half-built surface
    const repairs = session.recorder ? ++session.recorder.data.validationRepairs : 0;
    logger.warn("invalid surface", { surfaceId, repairs, errors: result.errors });
    if (repairs > MAX_RENDER_REPAIRS) {
      throw new ToolError(errorJson("A2UI_INVALID", "Слишком много неудачных попыток. Не вызывайте render_surface в этом ходе, сообщите пользователю об ошибке."));
    }
    throw new ToolError(errorJson("A2UI_INVALID", "Компоненты не прошли проверку A2UI v0.9, исправьте перечисленное", result.errors));
  }

  const value = surfaceId === "bill" ? session.project() : (data ?? {});
  const envelopes: A2uiEnvelope[] = [];
  if (streamed) {
    const rest = components.slice(streamed.sent) as A2uiComponent[];
    if (rest.length > 0) envelopes.push(updateComponents(surfaceId, rest));
  } else {
    if (session.surfaces.has(surfaceId)) envelopes.push(deleteSurface(surfaceId));
    envelopes.push(createSurface(surfaceId, { sendDataModel: true }), updateComponents(surfaceId, components as A2uiComponent[]));
  }
  envelopes.push(updateDataModel(surfaceId, value, "/"));
  if (surfaceId === "bill") session.lastVm = value as typeof session.lastVm; // a fresh surface gets the full model
  session.emit(envelopes);
  return JSON.stringify({ ok: true, surfaceId, rendered: components.length });
}

// --- tool set --------------------------------------------------------------------------

export function buildTools(session: Session) {
  const createBill = betaZodTool({
    name: "create_bill",
    description: "Create (or replace) the session's bill with all people and items. Money is computed by the server.",
    inputSchema: z.object({
      title: z.string().min(1),
      currency: z.string().optional().describe('Default "MDL"'),
      people: z.array(z.string().min(1)).min(1),
      items: z.array(ItemInput),
    }),
    run: (input) => {
      logger.debug("call", { session: session.id, tool: "create_bill", input });
      try {
        // Payer and split keys stay names here: the store resolves them case-insensitively.
        const items: NewItem[] = input.items.map((item) => ({
          title: item.title,
          price: parseMajor(item.price),
          paidById: item.paidBy,
          split: item.split ? splitByNames(item.split, input.people) : undefined,
        }));
        const bill = session.store.createBill(input.title, input.currency ?? "MDL", input.people, items);
        session.billId = bill.id;
        session.ui = {};
      } catch (err) {
        if (err instanceof DomainError) {
          logger.warn("domain error", { tool: "create_bill", code: err.code, details: err.details });
          throw new ToolError(errorJson(err.code, err.message, err.details));
        }
        throw err;
      }
      pushBillData(session);
      session.modelSeenVersion = session.store.version;
      return JSON.stringify({ ok: true, bill: billSnapshot(session) });
    },
  });

  const addPerson = betaZodTool({
    name: "add_person",
    description: "Add a participant. A new participant does not join existing items.",
    inputSchema: z.object({ name: z.string().min(1) }),
    run: (input) => domainTool(session, "add_person", input, (bill) => session.store.addPerson(bill.id, input.name)),
  });

  const renamePerson = betaZodTool({
    name: "rename_person",
    description: "Rename a participant.",
    inputSchema: z.object({ person: personRef, name: z.string().min(1) }),
    run: (input) =>
      domainTool(session, "rename_person", input, (bill) => session.store.renamePerson(bill.id, resolvePerson(bill, input.person).id, input.name)),
  });

  const removePerson = betaZodTool({
    name: "remove_person",
    description: "Remove a participant. Fails with the list of items while the person pays for or shares any item.",
    inputSchema: z.object({ person: personRef }),
    run: (input) => domainTool(session, "remove_person", input, (bill) => session.store.removePerson(bill.id, resolvePerson(bill, input.person).id)),
  });

  const addItem = betaZodTool({
    name: "add_item",
    description: "Add an item. Without split it is shared equally by everyone.",
    inputSchema: ItemInput,
    run: (input) =>
      domainTool(session, "add_item", input, (bill) => {
        const created = session.store.addItem(bill.id, {
          title: input.title,
          price: parseMajor(input.price),
          paidById: resolvePerson(bill, input.paidBy).id,
          split: input.split ? toSplit(bill, input.split) : undefined,
        });
        session.ui.selectedItemId = created.id;
      }),
  });

  const updateItem = betaZodTool({
    name: "update_item",
    description: "Change an item's title, price, payer or split. An exact split must add up to the price.",
    inputSchema: z.object({
      item: itemRef,
      patch: z.object({ title: z.string().min(1).optional(), price: money.optional(), paidBy: personRef.optional(), split: SplitInput.optional() }),
    }),
    run: (input) =>
      domainTool(session, "update_item", input, (bill) => {
        const item = resolveItem(bill, input.item);
        session.store.updateItem(bill.id, item.id, {
          ...(input.patch.title !== undefined ? { title: input.patch.title } : {}),
          ...(input.patch.price !== undefined ? { price: parseMajor(input.patch.price) } : {}),
          ...(input.patch.paidBy !== undefined ? { paidById: resolvePerson(bill, input.patch.paidBy).id } : {}),
          ...(input.patch.split !== undefined ? { split: toSplit(bill, input.patch.split) } : {}),
        });
        session.ui.selectedItemId = item.id;
      }),
  });

  const removeItem = betaZodTool({
    name: "remove_item",
    description: "Remove an item.",
    inputSchema: z.object({ item: itemRef }),
    run: (input) => domainTool(session, "remove_item", input, (bill) => session.store.removeItem(bill.id, resolveItem(bill, input.item).id)),
  });

  const getSummary = betaZodTool({
    name: "get_summary",
    description: "Shares, balances (paid − owes) and who pays whom. Use these numbers verbatim.",
    inputSchema: z.object({}),
    run: () => {
      requireBill(session);
      session.modelSeenVersion = session.store.version;
      return JSON.stringify({ ok: true, bill: billSnapshot(session) });
    },
  });

  const render = {
    ...betaZodTool({
      name: "render_surface",
      description:
        'Render an A2UI v0.9 surface from basic-catalog components. surfaceId "bill" = the main bill UI bound to the server data model; any other id = a new screen with your own data. Re-rendering an existing id replaces it.',
      inputSchema: RenderInput,
      run: (input, context?: BetaToolRunContext) => renderSurface(session, input, context?.toolUse.id),
    }),
    eager_input_streaming: true,
  };

  return [createBill, addPerson, renamePerson, removePerson, addItem, updateItem, removeItem, getSummary, render];
}

/** create_bill: split keys stay names (the store resolves names case-insensitively). */
function splitByNames(split: SplitInput, people: string[]): Split {
  if (split.type === "equal") return { type: "equal", personIds: split.people ?? people };
  if (split.type === "exact") return { type: "exact", amounts: Object.fromEntries(Object.entries(split.amounts).map(([k, v]) => [k, parseMajor(v)])) };
  return { type: "shares", weights: { ...split.weights } };
}
