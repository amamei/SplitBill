# REPORT — A2UI v0.9 (участник №2)

## Spike log

Run on 2026-10-04 against `@a2ui/react@0.12.0` + `@a2ui/web_core@0.12.0` (spec v0.9.1, upstream `a2ui-project/a2ui@1444719`), fixtures in `web/src/fixtures/spike.ts`, page `?spike=1`, headless Chromium via Playwright. Feed errors: **0**, console warnings/errors: **0**.

| # | Spike | Result |
|---|---|---|
| 1 | Single-level `List` template over `/items`, Button context `{"itemId": {"path": "id"}}` | ✅ Renders 3 rows. Click on row 2 → `context: {"itemId": "i2"}`. `sourceComponentId` is the template component id (`item_btn`), shared by all rows — the id in the context is what identifies the row. |
| 1b | `List` over an empty array | ✅ Renders nothing (no placeholder, no gap). "Visibility through data" works. |
| 2 | Nested templates `/groups[]` → `rows[]` (relative path `rows` inside the outer template) | ✅ Renders both levels; inner button context `{itemId, personId}` resolves to the inner row (`i2`/`p3`). Works in practice although upstream has no tests for it; the production view model still avoids it (master–detail `/editor`). |
| 3 | `TextField` / `CheckBox` two-way bound (top-level and inside a template), Button context `{"editor": {"path": "/editor"}}` | ✅ Typed title, toggled checkboxes and an edited amount inside the row template all arrive in `context.editor` as one object. `getRendererDataModel("v0.9")` returns the same values under `surfaces["spike-editor"]` (it includes only surfaces created with `sendDataModel: true`: this one and the upstream `34_child-list-template` example). |
| 4 | Upstream examples `34_child-list-template.json`, `00_incremental.json` verbatim | ✅ Both render without throwing. |

Findings that shape the implementation:

- **Published React renderer has empty CSS-module maps** for Button, Text, TextField, ChoicePicker (`var Button_default = {}` in `v0_9/index.js`), so those elements render without classes; Row/Column/List/Card/CheckBox use inline styles driven by `--a2ui-*` variables. Styled with element selectors under our own `.a2ui-root` wrapper (`web/src/a2ui.css`). `A2uiSurface` renders no wrapper element of its own, and the React renderer ignores `createSurface.theme`.
- **`Text` goes through the Markdown pipeline** (`@a2ui/markdown-it`) unless `variant` is a heading/caption: a string starting with `- ` or `1. ` becomes a list (visible in the upstream example: "Qty:" rendered as a bullet). Preformatted strings from the projector must avoid Markdown syntax at the start of a line.
- `MessageProcessor.processMessages` throws on the first invalid message; `feed()` applies envelopes one by one so one bad envelope does not drop the batch, and skips a repeated `createSurface` for a live surface (SSE replay).

## Лог затыков

- 2026-10-04 · Vite 8 dev server cannot load modules when the project path contains `#` (`~/workspaces/#hakaton/...`): `#` is treated as a URL fragment ("Failed to load url /src/main.tsx"). `vite build` works. Workaround: `web/scripts/dev.mjs` switches to `vite build --watch` when the path contains `#`, and the API server serves `web/dist` on :8787. Not an A2UI issue, cost ~10 min.
- 2026-10-04 · npm 12 blocks dependency install scripts by default (`esbuild`, `fsevents`); harmless here — esbuild ships its binary via `@esbuild/<platform>` optional deps.
- 2026-10-04 · Vitest is Vite-based and fails on the same `#` path ("Cannot find module '/src/…test.ts'"). Server tests use Node's built-in runner instead: `node --import tsx --test` with `node:assert`. Not an A2UI issue.
