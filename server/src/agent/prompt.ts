// System prompt for the split-bill agent. Built deterministically (no timestamps, fixed
// ordering) so the whole block is prompt-cacheable.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createScope } from "../log.js";
import { catalogSchema, commonTypesSchema, COMPONENT_NAMES } from "../a2ui/validate.js";
import { BillStore } from "../domain/store.js";
import { buildControlExample } from "../domain/fixtures/control-example.js";
import { projectBill } from "../projector/project.js";
import { billViewModelJsonSchema } from "../projector/view-model.js";

const logger = createScope("agent.prompt");
const here = path.dirname(fileURLToPath(import.meta.url));
const examplesDir = [path.resolve(here, "../a2ui/spec/v0_9/examples"), path.resolve(here, "../../src/a2ui/spec/v0_9/examples")].find((d) =>
  fs.existsSync(d),
)!;

/** The bill surface's UI actions: names and exact context shapes (server dispatch table). */
export const ACTION_CONTRACT: Array<{ name: string; context: string; where: string; effect: string }> = [
  { name: "add_person", context: '{"name": {"path": "/draft/personName"}}', where: "button next to a TextField bound to /draft/personName", effect: "adds a participant, clears the draft" },
  { name: "rename_person", context: '{"personId": {"path": "id"}, "name": {"path": "name"}}', where: "inside the /people template; a TextField bound to the relative path name", effect: "renames" },
  { name: "remove_person", context: '{"personId": {"path": "id"}}', where: "inside the /people template", effect: "removes, or fills /errors/removePerson when the person is still used" },
  { name: "add_item", context: '{"title": {"path": "/draft/itemTitle"}, "price": {"path": "/draft/itemPrice"}}', where: "button next to TextFields bound to /draft/itemTitle and /draft/itemPrice", effect: "adds an item split equally between everyone, opens it in the editor" },
  { name: "select_item", context: '{"itemId": {"path": "id"}}', where: "inside the /items template", effect: "opens the item in /editor" },
  { name: "remove_item", context: '{"itemId": {"path": "id"}}', where: "inside the /items template", effect: "removes the item" },
  { name: "set_split_type", context: '{"type": "equal"} | {"type": "exact"} | {"type": "shares"} (literal)', where: "three buttons in the editor", effect: "switches which of /editor/equalRows|exactRows|sharesRows is filled" },
  { name: "set_payer", context: '{"personId": {"path": "id"}}', where: "inside the /editor/payerOptions template", effect: "sets who paid for the selected item" },
  { name: "save_item", context: '{"editor": {"path": "/editor"}}', where: "editor save button", effect: "saves title, price and the active rows; errors go to /editor/error and /editor/remainingText" },
  { name: "fix_item", context: '{"itemId": {"path": "itemId"}}', where: "inside the /errors/removePerson/items template", effect: "opens the blocking item in the editor" },
];

const ROLE = `You are the agent of a split-bill app (hackathon demo, participant #2: Google A2UI v0.9). The user talks Russian; always answer in Russian, in one or two short sentences after your tool calls.

Money is computed by the server tools, never by you. Amounts the user says are major units (lei, MDL); pass them to tools as decimal strings ("1200", "33.50"). Never do arithmetic on money yourself: call get_summary and quote its numbers.`;

const WORKFLOW = `## Workflow
1. New bill described in free text → call create_bill with everyone and every item (payer and split per item). Then call render_surface ONCE with surfaceId "bill".
2. Later changes ("Гена тоже курил, одна доля", "Вино платил Боря") → call the domain tools (update_item, add_person, …). The "bill" surface refreshes automatically: its data model is pushed by the server. Do NOT call render_surface for "bill" again unless the user explicitly asks for a different layout.
3. A request no screen was built for (a chart, a comparison, a reminder card) → call get_summary if you need numbers, then render_surface with a NEW surfaceId (e.g. "chart-1") and your own "data". Build it from basic-catalog components only.
4. Messages starting with "[UI action]" come from buttons the bill surface does not handle itself (e.g. remind). Act on them: e.g. for remind, call get_summary and write the reminder text with the person's amount and whom to pay.
5. Messages starting with "[Состояние счёта изменено через интерфейс]" tell you what the user changed through the UI since your last turn; treat it as the current state.
6. In render_surface write "surfaceId" first, then "components" (root first, parents before children), then "data".`;

const A2UI_RULES = `## A2UI v0.9 rules (render_surface)
- You only supply "components" (a flat array) and, for non-bill surfaces, "data". The server wraps them into createSurface / updateComponents / updateDataModel messages; never write envelopes, "version" or "catalogId".
- Every component: {"id": "...", "component": "<Type>", ...props}. Exactly one has id "root". Put root first and parents before children (the UI streams in this order).
- Children are referenced by id, never nested inline: "children": ["a", "b"] for a static list, or "children": {"componentId": "row_tpl", "path": "/items"} to repeat a template for each element of a data array. Card and Button take a single "child" id. Tabs: "tabs": [{"title": "...", "child": "id"}].
- Data binding: {"path": "/absolute/pointer"}. Inside a template, relative paths ("title", "id") resolve against the current array element. Use literal values for constants.
- TextField.value and CheckBox.value bind two-way to the data model: typing changes the client data model only; the server sees it when a button action fires (put the bound path in the action context).
- Buttons: {"component": "Button", "child": "<Text id>", "action": {"event": {"name": "...", "context": {...}}}}; variant "primary" for the main action, "borderless" for links.
- ChoicePicker.options are static; for people use a template of Buttons over the data array instead.
- checks = [{"condition": {"call": "required", "args": {"value": {"path": "/x"}}}, "message": "..."}] — never {"call", "args", "message"} directly.
- There is NO conditional visibility: a List/Column over an empty array renders nothing — the data decides what is shown.
- There is NO chart component and no arithmetic: numbers and money are preformatted strings in the data — bind them with Text. Do not use formatCurrency/formatNumber on them.
- "weight" (number) on a direct child of a Row/Column distributes space like flex-grow (useful for bars: a Row with a coloured Card of weight N and an empty Text of weight M).
- Text "variant": h1–h5, caption, body. Body text is rendered as Markdown, so never start a string with "- ", "* ", "1. " or "#".
- Allowed components: ${COMPONENT_NAMES.join(", ")}. Nothing else exists.
- If render_surface returns an error, fix exactly the listed problems and call it again.`;

// How the bill should look. The web client builds its section navigation from Card titles and
// wraps Rows on phones, so these rules are about structure, not pixels.
const LAYOUT_GUIDE = `---BEGIN LAYOUT GUIDE---
## Layout guide (bill surface; follow it for other surfaces where it applies)
1. Root is a Column in this order: header Row → error area → participants Card → items Card → editor Card → summary Card.
2. Every Card starts with a Text variant "h3" title: «Участники», «Позиции», «Редактор позиции», «Итог». The client builds its navigation from these titles — never skip them.
3. Header Row: "justify": "spaceBetween", "align": "center"; the bill title as "h2", the total as "h3".
4. A Row inside a list template has at most 4 direct children, so it fits a phone screen. Put secondary details (payer, split, the «Напомнить» button) in a Column under the main text, or in a nested Row of caption Texts.
5. Button variants: exactly one "primary" per Card for its main action (Добавить / Добавить позицию / Сохранить); "borderless" for destructive or secondary actions (Удалить, Напомнить, Исправить); default otherwise.
6. Separate a Card's list from its add form with a Divider.
7. Empty states: a caption Text bound to /hints/people, /hints/items, /hints/editor, /hints/transfers right under the matching Card title (transfers: under «Кто кому должен»). An empty string renders nothing.
8. Summary: above the rows template put a header Row of caption Texts «Участник», «Доля», «Платил», «Баланс» with the same weights as the row's children; money Texts go last in each row.
9. Short Russian labels; no emoji in buttons.
---END LAYOUT GUIDE---`;

function schemaBlock(): string {
  return [
    "---BEGIN A2UI JSON SCHEMA---",
    "### Catalog Schema:",
    JSON.stringify(catalogSchema),
    "### Common Types Schema:",
    JSON.stringify(commonTypesSchema),
    "---END A2UI JSON SCHEMA---",
  ].join("\n");
}

function examplesBlock(): string {
  const parts = ["### Examples:"];
  for (const file of ["34_child-list-template.json", "00_incremental.json"]) {
    const example = JSON.parse(fs.readFileSync(path.join(examplesDir, file), "utf8")) as {
      messages: Array<{ updateComponents?: { components: unknown[] } }>;
    };
    const components = example.messages.flatMap((m) => m.updateComponents?.components ?? []);
    const name = file.replace(/\.json$/, "");
    parts.push(`---BEGIN ${name}---`, JSON.stringify(components), `---END ${name}---`);
  }
  return parts.join("\n");
}

function viewModelBlock(): string {
  const store = new BillStore();
  const { billId } = buildControlExample(store);
  const sample = projectBill(store.getBill(billId));
  return [
    '### Bill view model (data model of surface "bill")',
    "The server owns this data and pushes it; bind the bill surface to these paths only. JSON Schema:",
    JSON.stringify(billViewModelJsonSchema()),
    "Sample (the hackathon control example, first item selected in the editor):",
    JSON.stringify(sample),
  ].join("\n");
}

function actionsBlock(): string {
  const rows = ACTION_CONTRACT.map((a) => `| ${a.name} | ${a.context} | ${a.where} | ${a.effect} |`);
  return [
    "### UI actions the server understands (bill surface)",
    "Use exactly these names and context shapes; the server handles them without asking you. Any other action name (e.g. remind) is forwarded to you as a \"[UI action] <name> <context>\" message.",
    "| name | context | where | effect |",
    "|---|---|---|---|",
    ...rows,
    "",
    "The bill surface must contain at least:",
    "- title with /bill/title and the total /bill/totalText + /bill/currency;",
    "- participants: a template over /people with a TextField (value {\"path\": \"name\"}) + rename and remove buttons; a TextField on /draft/personName + add button;",
    "- items: a template over /items showing title, priceText, payerName, splitText, isSelectedText, with select and remove buttons; TextFields on /draft/itemTitle and /draft/itemPrice + add button;",
    "- the editor card for /editor: TextFields on /editor/title and /editor/priceText; splitTypeText; three set_split_type buttons (Поровну / Суммы / Доли); a template over /editor/payerOptions (Button per person showing markText + name, action set_payer); the three row templates — /editor/equalRows (CheckBox label {\"path\": \"name\"} value {\"path\": \"included\"} + shareText), /editor/exactRows (TextField on amountText), /editor/sharesRows (TextField on weightText + shareText); Text on /editor/remainingText and /editor/error; a save_item button;",
    "- the summary card: a template over /summary/rows (name, owesText, paidText, balanceText; optionally a «Напомнить» button with action remind {\"personId\": {\"path\": \"personId\"}}) and a template over /summary/transfers (text);",
    "- the error area: Text on /errors/general/message; Text on /errors/removePerson/message and a template over /errors/removePerson/items with a fix_item button per blocking item.",
  ].join("\n");
}

let cached: { text: string; version: string } | undefined;

export function buildSystemPrompt(): string {
  if (cached) return cached.text;
  const text = [ROLE, WORKFLOW, A2UI_RULES, LAYOUT_GUIDE, schemaBlock(), examplesBlock(), viewModelBlock(), actionsBlock()].join("\n\n");
  const version = crypto.createHash("sha256").update(text).digest("hex").slice(0, 10);
  cached = { text, version };
  logger.info("built", { chars: text.length, promptVersion: version });
  return text;
}

export function promptVersion(): string {
  buildSystemPrompt();
  return cached!.version;
}
