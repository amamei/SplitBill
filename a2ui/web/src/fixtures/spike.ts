// Renderer spikes (task 2): hardcoded A2UI v0.9 envelopes exercising the patterns the
// production view model depends on. Open the app with `?spike=1`.
import type { A2uiEnvelope } from "../a2ui/processor";
import childListTemplate from "./upstream/34_child-list-template.json";
import incremental from "./upstream/00_incremental.json";

export const CATALOG_ID = "https://a2ui.org/specification/v0_9/catalogs/basic/catalog.json";

const v = <T extends Record<string, unknown>>(body: T) => ({ version: "v0.9", ...body }) as A2uiEnvelope;

/** 1. Single-level template; button context resolves a relative path to the row's id. Also an empty list. */
const templateSpike: A2uiEnvelope[] = [
  v({ createSurface: { surfaceId: "spike-template", catalogId: CATALOG_ID } }),
  v({
    updateComponents: {
      surfaceId: "spike-template",
      components: [
        { id: "root", component: "Card", child: "col" },
        { id: "col", component: "Column", children: ["title", "list", "empty_caption", "empty_list"] },
        { id: "title", component: "Text", text: "Spike 1: List template + relative action context", variant: "h3" },
        { id: "list", component: "List", children: { path: "/items", componentId: "item_row" } },
        { id: "item_row", component: "Row", align: "center", children: ["item_title", "item_btn"] },
        { id: "item_title", component: "Text", text: { path: "title" }, weight: 1 },
        { id: "item_btn", component: "Button", child: "item_btn_label", action: { event: { name: "select_item", context: { itemId: { path: "id" } } } } },
        { id: "item_btn_label", component: "Text", text: "Выбрать" },
        { id: "empty_caption", component: "Text", text: "Below: List over an empty array (should render nothing)", variant: "caption" },
        { id: "empty_list", component: "List", children: { path: "/emptyItems", componentId: "empty_row" } },
        { id: "empty_row", component: "Text", text: { path: "title" } },
      ],
    },
  }),
  v({
    updateDataModel: {
      surfaceId: "spike-template",
      path: "/",
      value: {
        items: [
          { id: "i1", title: "Еда" },
          { id: "i2", title: "Кальяны" },
          { id: "i3", title: "Вино" },
        ],
        emptyItems: [],
      },
    },
  }),
];

/** 2. Nested template /groups[] -> rows[] (spike only; production VM avoids it). */
const nestedSpike: A2uiEnvelope[] = [
  v({ createSurface: { surfaceId: "spike-nested", catalogId: CATALOG_ID } }),
  v({
    updateComponents: {
      surfaceId: "spike-nested",
      components: [
        { id: "root", component: "Card", child: "col" },
        { id: "col", component: "Column", children: ["title", "groups"] },
        { id: "title", component: "Text", text: "Spike 2: nested templates", variant: "h3" },
        { id: "groups", component: "List", children: { path: "/groups", componentId: "group" } },
        { id: "group", component: "Column", children: ["group_title", "rows"] },
        { id: "group_title", component: "Text", text: { path: "title" }, variant: "h4" },
        { id: "rows", component: "List", children: { path: "rows", componentId: "row" } },
        { id: "row", component: "Row", align: "center", children: ["row_name", "row_btn"] },
        { id: "row_name", component: "Text", text: { path: "name" }, weight: 1 },
        { id: "row_btn", component: "Button", child: "row_btn_label", action: { event: { name: "nested_click", context: { itemId: { path: "itemId" }, personId: { path: "personId" } } } } },
        { id: "row_btn_label", component: "Text", text: "click" },
      ],
    },
  }),
  v({
    updateDataModel: {
      surfaceId: "spike-nested",
      path: "/",
      value: {
        groups: [
          { title: "Еда", rows: [{ itemId: "i1", personId: "p1", name: "Аня" }, { itemId: "i1", personId: "p2", name: "Боря" }] },
          { title: "Кальяны", rows: [{ itemId: "i2", personId: "p3", name: "Вика" }] },
        ],
      },
    },
  }),
];

/** 3. Two-way bound inputs; the whole /editor object travels in the action context. */
const editorSpike: A2uiEnvelope[] = [
  v({ createSurface: { surfaceId: "spike-editor", catalogId: CATALOG_ID, sendDataModel: true } }),
  v({
    updateComponents: {
      surfaceId: "spike-editor",
      components: [
        { id: "root", component: "Card", child: "col" },
        { id: "col", component: "Column", children: ["title", "field", "flag", "rows", "save"] },
        { id: "title", component: "Text", text: "Spike 3: two-way binding + object context", variant: "h3" },
        { id: "field", component: "TextField", label: "Название", value: { path: "/editor/title" } },
        { id: "flag", component: "CheckBox", label: "Флаг", value: { path: "/editor/flag" } },
        { id: "rows", component: "List", children: { path: "/editor/rows", componentId: "row" } },
        { id: "row", component: "Row", align: "center", children: ["row_check", "row_amount"] },
        { id: "row_check", component: "CheckBox", label: { path: "name" }, value: { path: "included" } },
        { id: "row_amount", component: "TextField", label: "Сумма", value: { path: "amountText" } },
        { id: "save", component: "Button", variant: "primary", child: "save_label", action: { event: { name: "save_item", context: { editor: { path: "/editor" } } } } },
        { id: "save_label", component: "Text", text: "Сохранить" },
      ],
    },
  }),
  v({
    updateDataModel: {
      surfaceId: "spike-editor",
      path: "/",
      value: {
        editor: {
          itemId: "i3",
          title: "Вино",
          flag: false,
          rows: [
            { personId: "p1", name: "Аня", included: true, amountText: "250.00" },
            { personId: "p2", name: "Боря", included: true, amountText: "250.00" },
          ],
        },
      },
    },
  }),
];

/** 4. Upstream spec examples, verbatim. */
const upstream: A2uiEnvelope[] = [
  ...(childListTemplate.messages as A2uiEnvelope[]),
  ...(incremental.messages as A2uiEnvelope[]),
];

export const spikeFixtures: Array<{ name: string; envelopes: A2uiEnvelope[] }> = [
  { name: "template", envelopes: templateSpike },
  { name: "nested", envelopes: nestedSpike },
  { name: "editor", envelopes: editorSpike },
  { name: "upstream", envelopes: upstream },
];
