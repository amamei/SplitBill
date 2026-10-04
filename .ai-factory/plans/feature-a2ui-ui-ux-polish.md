# Implementation Plan: A2UI Split Bill — UI & UX polish (navigation and look)

Branch: feature/a2ui-ui-ux-polish
Created: 2026-10-04
Base: branched from `feature/a2ui-split-bill` at `c1ccdad` (not from `main`: `main` does not contain the A2UI work).

## Original Request
Enchange UI & UX for confortable navigation and better look

## Settings
- Testing: yes
- Logging: verbose
- Docs: yes
- Scope: both the hand-written web shell (`a2ui/web`) and the look of the agent-rendered A2UI surface (CSS, renderer hooks, prompt layout guidance, view-model hints)
- UX constraints: mobile-friendly layout; dark mode; debug log hidden by default; Russian UI copy

## Research Context
Source: `.ai-factory/RESEARCH.md` (Active Summary, Updated: 2026-10-04 18:44, SHA256: c1535d6f0db2487118ca4e352705658d98efed5ab6f8555039f4b31473842a3b)

Topic: Using Google A2UI (protocol v0.9) to implement the Split Bill hackathon app described in `TZ.md` (participant #2 of the tool comparison).

Goal: Build `a2ui/` — a working Split Bill demo where the agent emits A2UI v0.9 messages rendered natively by an A2UI renderer, covering S1–S6 (+ S7 and beyond where possible), the control example from TZ §6 with matching numbers, and a `REPORT.md` filled per TZ §7.

Constraints:
- From `TZ.md`: one shared model for all participants; money is computed by code, never by the model; amounts are integer minor units, no float; in-memory storage, no auth/DB/deploy; one-command run; 1:30 cutoff for the first rendered screen.
- A2UI v0.9 facts (verified in the `a2ui-project/a2ui` repo, spec `specification/v0_9_1`):
  - Server→client messages: `createSurface {surfaceId, catalogId, theme?, sendDataModel?}`, `updateComponents {surfaceId, components[]}`, `updateDataModel {surfaceId, path?, value?}` (replaces value at JSON Pointer path; `/` replaces whole model), `deleteSurface {surfaceId}`.
  - Client→server: `action {name, surfaceId, sourceComponentId, timestamp, context}` and `error`. With `sendDataModel: true` the client attaches the full surface data model (`a2uiClientDataModel`) to transport metadata of every message.
  - Components are a flat list: `{id, component: "<Type>", ...props}`; one must have `id: "root"`. Children: static `["id1","id2"]` or template `{"path": "/list", "componentId": "tpl"}`; relative paths resolve inside the template scope.
  - Inputs are two-way bound to the local data model; typing never triggers network — state reaches the server only with an action.
  - Actions: server `{"event": {"name", "context"}}` or local `{"functionCall": {"call", "args"}}`.
  - Basic catalog components: Text, Image, Icon, Video, AudioPlayer, Row, Column, List, Card, Tabs, Modal, Divider, Button, TextField (`variant`: longText|number|shortText|obscured), CheckBox, ChoicePicker, Slider, DateTimeInput. Functions: required, regex, length, numeric, email, formatString, formatNumber, formatCurrency, formatDate, pluralize, openUrl, and, or, not.
  - Basic catalog gaps relevant to TZ: no conditional visibility property; no arithmetic functions; `ChoicePicker.options` is a static array (labels dynamic, values static strings), not bindable to a data list; Tabs has no data-bound selected state; no chart component; no file input.
  - Extensibility: custom catalogs with custom components (Zod schema + `createComponentImplementation`) and custom functions (`createFunctionImplementation`), composed via `new Catalog(id, 'v0.9', components, functions)` in `@a2ui/web_core/v0_9` / `@a2ui/react/v0_9`.
  - Package versions: `@a2ui/react`, `@a2ui/lit`, `@a2ui/web_core` at 0.12.0; TS agent SDK `@a2ui/agent` at 0.0.1; Python `a2ui-agent-sdk` (`A2uiSchemaManager`, `generate_system_prompt`, `validate_components`, streaming parser with JSON healing, ADK `SendA2uiToClientToolset`). Repo `main` has spec v0.9.1 as production and v1.0 as RC; `catalogs/basic/v1/catalog.json` on main uses the `v1_0` catalogId, while `specification/v0_9_1/catalogs/basic/catalog.json` uses `https://a2ui.org/specification/v0_9/catalogs/basic/catalog.json`.
  - Renderers: Lit, Angular, React (web) — repo README and `renderers/`; Flutter via the separate GenUI SDK — repo README and v0.9 blog post.
  - Inference (not verified): no MCP-Apps-style chat host (Claude / ChatGPT / VS Code) renders A2UI in this setup, so the demo runs on our own site. Note TZ §2 says CopilotKit + AG-UI "умеет рендерить и A2UI, и MCP Apps" (can render both A2UI and MCP Apps), which is a possible alternative host.

Decisions:
- Authoring model = option C (recommended, not yet confirmed by user): the LLM authors the component tree (layout) for S1 and for new screens (S7); code owns the data model. The tree is bound to a fixed view-model shape produced by a code "projector" (Bill → view model). Subsequent CRUD changes push only `updateDataModel`.
- CRUD actions from the UI (S2–S5) are dispatched by code directly to domain tools (action name → tool), no model round trip; only free text (S1, S6), S7, S8, S9 go through the LLM.
- Work around catalog gaps with data, not custom components. The workarounds below are untested inferences; they are checked by the spikes listed in Open questions:
  - "Visibility through data": render split-specific fields via List templates over `equalRows` / `exactRows` / `sharesRows`; the projector fills only the list for the active split type (empty list renders nothing — inference, untested). Same for the S2 error block (`/errors/removePerson/items`).
  - Split type switch: three buttons (equal/exact/shares) sending `set_split_type`, not Tabs.
  - Payer selection: a List of buttons over `/people` with `action{set_payer, {itemId, personId}}` (avoids static `ChoicePicker.options` and keeps the layout stable); the alternative (resending `updateComponents` when people change) breaks "layout never changes".
  - Edits: TextFields + Save button with `sendDataModel: true`; server parses strings into minor units in code.
  - Display strings (`priceText`, `owesText`, …) are preformatted by the projector; `formatCurrency` is not applied to minor-unit ints.
  - Denormalize ids into nested rows (`itemId` inside each row) because nested templates resolve relative paths in the inner scope.
- Tentative, pending the policy question in Open questions: allow custom functions (e.g. `remaining(price, amounts)`, maybe `formatMinor`), but no custom components. If custom functions are ruled out, the fallback is a "Пересчитать" (recalculate) button that sends an action and the server returns `remainingText`. Record every extension in `REPORT.md` under "Кто автор UI" — each custom component moves the result toward the MCP Apps baseline.
- S7 is tested honestly with the basic catalog only (e.g. bars via Row + Card `weight` — inference, untested); adding a `BarChart` component would pre-plan the "unplanned" request.
- Stack choice depends on the shared model: Gemini → official path (Python ADK + `a2ui-agent-sdk` + A2A + fork of `samples/agent/adk/restaurant_finder` and `samples/client/react/shell`); Claude/GPT → try ADK via `LITELLM_MODEL` first, fall back to the thin path (Node/TS + model SDK + SSE + `@a2ui/react` + `@a2ui/web_core`) if not working by the 1:30 cutoff.
- Pin v0.9 imports (`@a2ui/react/v0_9`, `@a2ui/web_core/v0_9`) and the matching v0.9 catalogId so the model does not mix v0.9 and v1.0.

Open questions:
- Which shared model is chosen (drives the stack choice)?
- Do relative paths inside `event.context` within a List template work (e.g. `{"itemId": {"path": "id"}}`)? The catalog hint says "Do NOT use paths for static IDs" — inside templates a path is required. Highest-priority spike.
- Do nested List templates (items → rows) render correctly in the React renderer?
- How does the `sendDataModel` payload arrive over a custom (non-A2A) transport? The spec describes A2A metadata / HTTP header; on custom SSE/HTTP it must be carried manually.
- Generated tree size, output tokens and latency for S1 (estimate: ~40–60 components thanks to templates) — measure.
- Bonus: render the same JSONL in Lit and React side by side to demonstrate portability?
- Policy: is a custom client function like `remaining()` acceptable as "tool used as intended" or counted as hand-written UI?
- Team-wide (affects all four participants): units in the TZ §6 control example — "Еда 1200" reads as whole units, while "100 → 33.34" implies cents; agree whether 1200 means 1200 or 120000 minor units.

Success signals:
- S1–S6 shown live on the control example with numbers matching TZ §6 (including post-S6 balances +465/+425/−365/−525 and edge cases: rounding 33.34/33.33/33.33, `exact` 590 vs 600 → "не распределено 10", removing Гена → error referencing "Еда" and "Чаевые").
- S6 produces only `updateDataModel` messages (no `updateComponents`) — demonstrable via the message log.
- S2–S5 UI actions complete without a model round trip.
- First rendered screen before the 1:30 cutoff; S1 reliability measured over 10 runs; tokens/latency measured for S1 and S5.

Next step: Resolve the shared model, then run `/aif-plan full A2UI Split Bill` (first tasks: hello-world surface, domain logic + control-example test, spike on template-scoped action context and nested lists).

## Requirements Reconciliation

Authority (highest first): `TZ.md` → research Active Summary above → previous plan `.ai-factory/plans/feature-a2ui-split-bill.md` (accepted design decisions) → preferences given in this planning session.

| # | Rule | Source | Relation | Decision in this plan |
|---|------|--------|----------|-----------------------|
| R1 | The model authors the `bill` component tree from the basic catalog; code owns the data | `TZ.md:183` "Кто автор UI", research "Authoring model = option C", `a2ui/REPORT.md:13` | agree | Keep. The shell may be hand-written (it already is). Layout of the `bill` surface changes only through prompt guidance (T10), never through a hand-written tree shipped to the demo. |
| R2 | No custom components; every extension is recorded in REPORT | research Decisions ("no custom components"; "Record every extension in REPORT.md") | refines | T9 replaces the **implementation** of the basic `Button` (same name, same API schema, same catalogId) only to add variant CSS classes that `@a2ui/react@0.12.0` drops (empty CSS-module maps, `node_modules/@a2ui/react/v0_9/index.js:756-766`). The model-facing catalog is unchanged. It is recorded in REPORT under "Контроль внешнего вида" as a renderer fix (T12). If the user rejects this, T9 drops out and primary/borderless stay identical. |
| R3 | S6: a free-text edit patches data, it does not redraw (`updateComponents` = 0) | `TZ.md:119-121`, `a2ui/server/scripts/smoke-s1.ts` | agree | The layout guide (T10) keeps "render `bill` ONCE". Hints are data fields that the projector fills, so they arrive with `updateDataModel` only. |
| R4 | "Visibility through data": an empty list or empty string renders nothing | research Decisions | agree | Empty-state hints are `/hints/*` strings that the projector fills or clears (T10). There is no conditional component. |
| R5 | Look control is a measured criterion ("можно ли натянуть свою дизайн-систему") | `TZ.md:190`, `a2ui/REPORT.md:20` | agree | Tokens and theme via CSS (T1, T8). `createSurface.theme` is honoured by the client (T5) and sent by the server (T10). The findings go to REPORT (T12). |
| R6 | Money is formatted by code and never by the model | `TZ.md:44-48` | agree | No change. Hints and labels are plain strings, and amounts stay `*Text` fields. |

Behaviour combinations that must work (verify each in T11):

| Viewport | Theme | Debug drawer | Surfaces present | Expected |
|----------|-------|--------------|------------------|----------|
| desktop ≥ 860px | system/light/dark | closed (default) | none | Two panes. The chat shows the onboarding empty state. The surfaces pane shows the placeholder card. |
| desktop ≥ 860px | light and dark | open | `bill` | The bill renders with an outline nav ("Участники · Позиции · Редактор · Итог"). The drawer overlays the right side without shifting the layout. Esc closes it. |
| desktop ≥ 860px | dark | closed | `bill` + `chart-1` | The surface switcher shows both. The new surface scrolls into view and flashes once. Extra surfaces can be collapsed or hidden locally. |
| mobile < 860px | light and dark | closed | none → `bill` | The bottom tab bar shows "Чат / Счёт". The first surface auto-switches to "Счёт". Later updates on the other tab show a dot. Rows wrap with no horizontal scroll at 375px. |
| mobile < 860px | dark | open | `bill` | The drawer shows as a bottom sheet. Esc or "Закрыть" closes it. |

Representative real artifact: the control example from `TZ.md` §6, seeded with `A2UI_DEBUG=1` + `POST /api/debug/seed`, which loads the control example and `REFERENCE_BILL_TREE` with no model call. When `ANTHROPIC_API_KEY` is set, also check one live S1 and S6 run, so the model-authored tree is covered too.

## Context for the implementer

- Web client: `a2ui/web` (React 19, Vite 8, `@a2ui/react@0.12.0` v0_9, no UI library). There is no HMR in this checkout, because the `#` in the path makes `web/scripts/dev.mjs` fall back to `vite build --watch`. The server serves `web/dist` at http://localhost:8787, so reload by hand after a rebuild.
- Renderer facts (verified in `node_modules/@a2ui/react/v0_9/index.js`):
  - CSS-module maps for Button, Text, TextField and ChoicePicker are `{}`, so these components have no classes. `--a2ui-button-*`, `--a2ui-textfield-*`, `--a2ui-choicepicker-*` and `--a2ui-text-*` have no effect, and that includes `--a2ui-text-caption-color` at `a2ui.css:63`.
  - Working hooks:
    - `.a2ui-card`, `.a2ui-tabs-header` and `.a2ui-tab-button.active`, `.a2ui-modal-*`, `button.chip(.selected)`.
    - Text wrappers: `div.h1`..`div.h5` containing `h1`..`h5`, `div.body`, and caption as `span > em`.
    - Row, Column and List have inline styles only. Target them with `div[style*="flex-direction: row"]`; overriding needs `!important`.
    - The loading placeholder is `div[style*="color: gray"]` with the text `[Loading <id>...]`.
  - The default token sheet is adopted with `:where()`, so it has zero specificity. It reads `color-scheme`, `light-dark()` and the `.a2ui-dark` / `.a2ui-light` classes.
  - `createSurface.theme` is stored on `SurfaceModel.theme` and ignored by the renderer.
  - The catalog is built as `new Catalog("https://a2ui.org/specification/v0_9/catalogs/basic/catalog.json", "0.9", basicComponents, BASIC_FUNCTIONS, BasicCatalogThemeSchema)` (`index.js:1076-1103`). All components plus `createComponentImplementation` are exported. `ButtonApi`, `BASIC_FUNCTIONS` and `BasicCatalogThemeSchema` come from `@a2ui/web_core/v0_9/basic_catalog`.
- Web-side logging: add `web/src/lib/log.ts` (T2) with `debug/info/warn/error(scope, msg, data?)`. It prints `console.debug("[ui.<scope>] msg", data)` only when debug is enabled (`?debug=1` or the `a2ui-debug` pref); `warn` and `error` always print. Every task below logs through it. Do not use bare `console.*` in new code, except the existing `[a2ui.action]` line in `processor.ts`.
- Browser storage: all `localStorage` and `sessionStorage` access goes through `web/src/lib/prefs.ts` with try/catch. The UI must render correctly when storage throws.
- Server tests: `npm test` from `a2ui/`. There are no web tests today. T2 adds `node --import tsx --test` for the pure helpers in `web/src/lib/` (`tsx` is already hoisted in `a2ui/node_modules`), with no new dependency.
- Keep these unchanged: the `---BEGIN A2UI JSON SCHEMA---` and `---BEGIN 34_child-list-template---` markers in the prompt, prompt determinism, `KNOWN_ACTIONS` and `ACTION_CONTRACT`, and every action name used in `REFERENCE_BILL_TREE`.

## Tasks

### Phase 1: Design foundation

- [x] **T1. Split styles and rebuild the design tokens**
  - Files: delete `a2ui/web/src/a2ui.css`. Create `a2ui/web/src/styles/tokens.css`, `base.css`, `shell.css` and `surface.css`, plus `index.css` that imports them in that order. Import `./styles/index.css` once from `a2ui/web/src/main.tsx` and remove the CSS import from `App.tsx:2`.
  - `tokens.css`:
    - Light palette on `:root`: keep the warm paper and green accent identity.
    - Add `--accent-soft`, `--success`, `--warning`, `--danger-soft` and `--shadow-1` / `--shadow-2`.
    - Spacing scale `--space-1..6` (4/8/12/16/24/32px), radii `--radius-s/m/l` (6/10/14px), type scale `--font-size-xs..xl`, and `--font-mono`.
    - Font stack: `system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`. Remove the unloaded `Inter`.
    - Dark palette under `@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) {…} }` and again under `:root[data-theme="dark"]`.
    - `color-scheme: light dark` by default. Set `color-scheme: light` or `dark` under the explicit `data-theme`, so the renderer's `light-dark()` follows the manual choice.
  - `base.css`: box-sizing; `body` with an explicit `background: var(--page-bg)`; `:focus-visible` ring (2px `--accent`, offset 2px) on all interactive elements; a `.visually-hidden` utility; `@media (prefers-reduced-motion: reduce)` that disables transitions and animations; `@media (pointer: coarse)` with a minimum 44px height for buttons and inputs.
  - `shell.css` and `surface.css`: move the existing shell rules (`a2ui.css:124-174`) and `.a2ui-root` rules (`a2ui.css:45-122`) over unchanged for now. T3–T8 rework them. Replace the hard-coded `.badge-*` colours (`a2ui.css:168-171`) with tokens.
  - Logging: none (CSS only).
  - Done when `npm -w web run build` passes and the page looks the same as before or better in light and dark (OS setting), with no hard-coded hex values outside `tokens.css`.

- [x] **T2. Preferences, theme switcher, debug logger and web test runner**
  - Create these files:
    - `a2ui/web/src/lib/prefs.ts`: `readPref<T>(key, fallback, parse)` and `writePref(key, value)` over `localStorage`, wrapped in try/catch. On failure it returns the fallback and logs `warn("prefs", "storage unavailable", {key})` once per key. Keys: `a2ui-theme` (`"system"|"light"|"dark"`), `a2ui-debug` (`"1"|"0"`), `a2ui-debug-open`.
    - `a2ui/web/src/lib/log.ts`: as described under "Context for the implementer".
    - `a2ui/web/src/lib/theme.ts`: `resolveTheme(pref, systemDark): "light"|"dark"` (pure), `applyTheme(pref)`, and `watchSystemTheme(cb)` (a `matchMedia` listener).
      - `applyTheme(pref)` sets `document.documentElement.dataset.theme` (removes it for `system`) and toggles `.a2ui-dark` / `.a2ui-light` on `<html>`.
      - It updates `<meta name="theme-color">` and logs `debug("theme", "applied", {pref, resolved})`.
    - `a2ui/web/src/components/ThemeToggle.tsx`: a 3-state segmented control "Системная / Светлая / Тёмная".
      - Render it as `role="radiogroup"` with `aria-checked` and a short icon plus a visually-hidden label.
      - It persists the choice through prefs.
  - `a2ui/web/index.html`:
    - Add `<meta name="color-scheme" content="light dark">` and `<meta name="theme-color" content="#f4f2ee">`.
    - Add an inline SVG data-URI favicon showing a split coin.
    - Add a tiny inline pre-paint `<script>` that reads `a2ui-theme` inside try/catch and sets `data-theme` before first paint, so there is no flash.
  - Tests: create `a2ui/web/src/lib/__tests__/prefs.test.ts` and `theme.test.ts`.
    - Inject a fake storage object; cover a throwing storage, an invalid value falling back, and the four combinations of `resolveTheme`.
    - Add `"test": "node --import tsx --test \"src/**/__tests__/*.test.ts\""` to `a2ui/web/package.json`. Change the root `a2ui/package.json` `test` to `npm -w server test && npm -w web test`.
  - `web/tsconfig.json`: keep the `__tests__` files inside `include`, so `typecheck` covers them. If `node:test` types are missing, add `"types": ["node"]` (`@types/node` is already present in the workspace).
  - Done when `npm test` from `a2ui/` runs both suites green, the toggle switches the theme instantly and keeps it across reloads, and a throwing `localStorage` (simulate it in a test) does not break rendering.

### Phase 2: Shell layout and navigation

- [x] **T3. App header, connection status and activity indicator**
  - Create `a2ui/web/src/components/AppHeader.tsx` and replace the header at `App.tsx:98-101` with it. It is sticky (`position: sticky; top: 0`), uses a blurred panel background and has a bottom border. Contents, left to right:
    - Brand "Split Bill" with a caption "A2UI v0.9".
    - `ConnectionStatus`.
    - A thin activity bar.
    - On the right: `ThemeToggle` and a "Отладка" button. The button has `aria-pressed` and `aria-controls="debug-drawer"`, plus a counter badge of render errors. It is visible only when debug is enabled (`?debug=1` or the pref); otherwise it is hidden, and Ctrl/Cmd+Shift+D enables it (T4).
  - Create `a2ui/web/src/components/ConnectionStatus.tsx` to replace `ConnectionDot` (`App.tsx:71-75`).
    - Show a pill with a dot plus text: "В сети", "Переподключение…" or "Нет связи".
    - Use `role="status"` and `aria-live="polite"`.
    - States come from `api.ts`. Publish `connection {state: "open"|"reconnecting"|"closed"}`: `onerror` with `readyState === CONNECTING` means reconnecting, and `CLOSED` means closed. Keep the old `{open}` boolean for compatibility only if something else reads it; grep first.
    - Log transitions with `info("conn", …)`.
  - Activity bar: in `a2ui/web/src/a2ui/api.ts`, wrap `postAction`, `postChat` and `postUpload` to publish `activity {pending: number}` (an in-flight counter, decremented in `finally`). Log `debug("api", "request start/end", {kind, ms})`.
    - The header shows a 2px indeterminate progress bar while `pending > 0` or the chat is busy (subscribe to the existing `chat.note` / `chat.done` / `forwarded` events).
    - This fixes the current gap where server-handled UI actions (add person, save item) give no feedback.
  - Done when the header shows readable connection state in both themes, stopping the server flips it to "Переподключение…" or "Нет связи", and clicking any A2UI button shows the bar until the response arrives.

- [x] **T4. Responsive two-pane layout, mobile tab bar and keyboard shortcuts**
  - Create `a2ui/web/src/lib/media.ts`: a `useMediaQuery(query)` hook (`useSyncExternalStore` over `matchMedia`) and the constant `MOBILE_QUERY = "(max-width: 859.98px)"`.
  - Create `a2ui/web/src/lib/shortcuts.ts`: a pure `matchShortcut(e: Pick<KeyboardEvent,"key"|"ctrlKey"|"metaKey"|"shiftKey"|"altKey"|"isComposing"> , targetIsEditable: boolean): Action | null`. Actions:
    - `/` → `focusComposer`, only when the target is not editable.
    - `Escape` → `closeOverlays`.
    - Ctrl/Cmd+Shift+D → `toggleDebug`.
    - Alt+1 → `showChat` and Alt+2 → `showBill`, which only matter on mobile but are harmless on desktop.
  - Create `a2ui/web/src/components/MobileTabBar.tsx`:
    - A fixed bottom bar with two buttons, "Чат" and "Счёт", with `role="tablist"`, `aria-selected` and `aria-controls`.
    - An unseen-update dot appears on the inactive tab when chat lines or A2UI envelopes arrive for it.
    - Padding is `env(safe-area-inset-bottom)`.
  - `a2ui/web/src/App.tsx`:
    - Hold `activePane: "chat"|"bill"`. On mobile render only the active pane, but keep the other mounted and hide it with the `hidden` attribute, so chat state and scroll survive.
    - When the first surface is created (`processor.onSurfaceCreated`) on mobile, switch to "bill" automatically once per session.
    - Register a single `keydown` listener on `window` that dispatches `matchShortcut`. Log `debug("shortcut", action)`.
  - `shell.css`:
    - Desktop grid `minmax(300px, 400px) minmax(0, 1fr)`.
    - The chat pane is sticky below the header with `height: calc(100dvh - var(--header-h) - var(--space-4)*2)`, so only its message list scrolls.
    - The surfaces pane scrolls with the page.
    - Mobile is one column with `padding-bottom` reserved for the tab bar and the chat composer pinned above it.
    - Add an intermediate breakpoint at 1180px that narrows the chat column.
  - Tests: create `a2ui/web/src/lib/__tests__/shortcuts.test.ts` covering every mapping, the editable-target guard for `/`, `isComposing` → null, and Ctrl versus Meta.
  - Done when the layout is usable at 375, 768, 1024 and 1440px with no horizontal page scroll, the tab switch preserves chat scroll and input text, and the shortcuts work and are ignored while typing (except Esc).

- [x] **T5. Surface frames, surface switcher and in-surface outline navigation**
  - Create `a2ui/web/src/lib/surfaces.ts` (pure, tested):
    - `orderSurfaces(ids)`: `bill` first, then creation order (moved from `Surfaces.tsx:24`).
    - `surfaceTitle(id, theme?)`:
      - Implementation note: `bill` is always titled "Счёт", even when its theme carries `agentDisplayName` ("Split Bill" is the brand, not a section title).
      - `theme.agentDisplayName` if it is a non-empty string, else:
      - `bill` → "Счёт";
      - `chart-N` → "Диаграмма N";
      - otherwise humanize the id (`-`/`_` become spaces, first letter capitalised).
    - `safeAccent(theme?)`: returns `primaryColor` only if it matches `/^#[0-9a-f]{6}$/i`, else `undefined`.
    - `slugHeading(text, used: Set<string>)`: makes stable anchor ids for headings.
  - Create `a2ui/web/src/components/SurfaceFrame.tsx`, wrapping each `<section class="a2ui-root">`:
    - A frame header with the title (`h2`, id used by `aria-labelledby`). Apply the accent as an inline `--accent` / `--a2ui-color-primary` when `safeAccent` returns one.
    - For non-`bill` surfaces, a "Свернуть / Развернуть" button (`aria-expanded`) and a "Скрыть" button. "Скрыть" hides the surface locally, keeps a "Показать скрытые (n)" chip in the switcher, and never sends `deleteSurface`.
    - On creation of a non-`bill` surface: `scrollIntoView({behavior: "smooth", block: "start"})` (instant under reduced motion), plus a one-time 1.2s accent outline flash.
  - Create `a2ui/web/src/components/SurfaceNav.tsx`, a sticky bar at the top of the surfaces pane:
    - One chip per visible surface (switcher; click scrolls to the frame and marks it current).
    - For the current surface, a row of outline chips built from the rendered headings. Use a `MutationObserver` on the frame (debounce 150ms) to collect `.h2 > h2, .h3 > h3` text, assign ids with `slugHeading`, and set `scroll-margin-top` to the header height plus the nav height.
    - Highlight the active chip with an `IntersectionObserver` and set `aria-current="true"`.
    - Hide the outline row when there are fewer than 2 headings.
    - Log `debug("nav", "outline", {surfaceId, headings})` when the outline changes.
  - Update `a2ui/web/src/components/Surfaces.tsx`:
    - Use these helpers.
    - Replace the empty paragraph (`Surfaces.tsx:25-27`) with an empty-state card: "Здесь появится счёт" plus one line of explanation and a hint "Начните с сообщения в чате или примера ниже".
    - Read `surface.theme` from `SurfaceModel`; if the typed field name differs in `@a2ui/web_core` 0.12, check `node_modules/@a2ui/web_core/src/state/surface-model.js:57`.
  - Tests: create `a2ui/web/src/lib/__tests__/surfaces.test.ts` covering ordering, titles (theme name, bill, chart-2, custom id), rejection of `safeAccent` input such as `red` / `#fff` / `javascript:`, and slug de-duplication and Cyrillic handling.
  - Done when, with the seeded control example, the outline shows "Участники · Позиции · Редактор позиции · Итог" (headings of the reference tree), clicking a chip scrolls to the card below the sticky bars, and an S7 surface appears in the switcher, scrolls into view and can be collapsed or hidden.

- [x] **T6. Debug drawer hidden by default, and user-facing render errors**
  - Create `a2ui/web/src/components/DebugDrawer.tsx` to host the current `MessageLog` content (turn table plus envelope list).
    - Closed by default (fixes `MessageLog.tsx:17` `open = true`).
    - Opened by the header "Отладка" button, by Ctrl/Cmd+Shift+D, or automatically on load when `?debug=1&log=open`. The open state persists through the `a2ui-debug-open` pref.
    - Desktop: a right-side drawer 520px wide (max 90vw) over the content with `role="dialog"`, `aria-modal="false"`, `id="debug-drawer"`, a title and a "Закрыть" button.
    - Mobile: a bottom sheet at 80dvh.
    - Esc closes it (via `closeOverlays`) and focus returns to the toggle.
    - It keeps collecting envelopes while closed. Collection must start at app mount, not when the drawer opens, because the turn table is evidence for the TZ §7 report.
  - Refactor `a2ui/web/src/components/MessageLog.tsx` into presentational pieces (`TurnsTable`, `EnvelopeList`) that take the data as props. Move the subscription state into a `useDebugFeed()` hook in `a2ui/web/src/lib/debugFeed.ts`, mounted once in `App.tsx`.
  - Move `FeedErrors` (`App.tsx:50-69`) into the drawer as a "Ошибки рендера (n)" section, keeping the raw envelope JSON there.
  - For users, add `a2ui/web/src/components/Toast.tsx`, a single polite toast region (`role="status"`) that shows "Часть интерфейса не отрисовалась. Подробности — в отладке." for 6s on new feed errors. It has a "Подробнее" button that opens the drawer when debug is enabled.
  - Log `warn("feed", "render rejected", {type, message})` for each feed error, and `debug("debug", "drawer", {open})`.
  - Done when a fresh load shows no log at all, the drawer opens and closes with the button, the shortcut and Esc, the turn table still fills during S1 while the drawer is closed, and a forced bad envelope in `?spike=1` shows the toast.

### Phase 3: Chat UX

- [x] **T7. Chat: onboarding, smart scroll, typing indicator and accessible composer**
  - Files: `a2ui/web/src/components/Chat.tsx`, plus a new `a2ui/web/src/lib/scroll.ts` (pure `isNearBottom(scrollTop, clientHeight, scrollHeight, threshold = 48)`) and `shell.css`.
  - Copy and quick prompts (`Chat.tsx:6-13`): keep the exact message texts, which are the TZ scenarios, and change only the labels to "Пример из ТЗ", "Гена курил — правка", "Диаграмма долгов". Show them as chips.
  - Empty state: replace `.chat-hint` with an onboarding card. It has a title "Разделим счёт", one sentence of explanation, the same three example chips, and a hint "Enter — отправить, Shift+Enter — новая строка, / — к полю ввода".
  - List semantics: `role="log"`, `aria-live="polite"`, `aria-relevant="additions"`. User bubbles align right; assistant bubbles align left with a small "Агент" label; notes are centred; errors are bubbles with a danger border and a "Повторить" button that resends the last user text.
  - Smart scroll: auto-scroll only if the user was near the bottom before the update. Otherwise show a floating "Новые сообщения ↓" pill that scrolls down and hides on click. Log `debug("chat", "autoscroll", {stick})` when it changes.
  - Busy: replace the "Агент думает…" line with a typing indicator (three animated dots, `aria-label="Агент печатает"`), kept for the whole turn.
  - Composer:
    - Add a visually-hidden `<label for>` "Сообщение агенту".
    - The textarea auto-resizes from 1 to 6 rows.
    - Enter sends only when `!e.nativeEvent.isComposing` (IME guard).
    - It receives focus from the `/` shortcut and after the mobile tab switch to "Чат".
    - On mobile it stays sticky above the tab bar.
  - Photo: show a thumbnail preview in the user bubble (`URL.createObjectURL`; revoke it on unmount) instead of `📷 filename` only. Keep the filename as the alt text.
  - Tests: create `a2ui/web/src/lib/__tests__/scroll.test.ts` with boundary cases (exactly at the threshold, an empty list, scrollHeight < clientHeight).
  - Done when, during a streamed S1, scrolling up is not yanked back down, the pill appears and works, screen readers announce new assistant text (VoiceOver spot check), and Japanese/Russian IME composition does not send early.

### Phase 4: A2UI surface look

- [x] **T8. Surface stylesheet: cards, typography, inputs, rows and loading skeleton**
  - Rework `a2ui/web/src/styles/surface.css`, keeping everything scoped under `.a2ui-root`.
  - Renderer tokens: map `--a2ui-*` to the T1 tokens. Includes the colour set, `--a2ui-border-radius: var(--radius-s)`, `--a2ui-spacing-*`, `--a2ui-font-size-*`, the card vars (shadow `--shadow-1`, radius `--radius-l`, padding `var(--space-4)`, margin `0 0 var(--space-4)`), the tabs vars and `--a2ui-divider-spacing`. Remove the dead `--a2ui-text-caption-color`.
  - Typography:
    - `.h2 > h2` and `.h3 > h3` get tightened sizes and weights. `.a2ui-card .h3:first-child > h3` becomes the card title, with a bottom margin and an optional subtle bottom border.
    - Captions are `span > em`: muted, no italics, `--font-size-xs`.
    - `div.body p` has a normal line height.
    - Numbers: `font-variant-numeric: tabular-nums` on the whole surface, so money columns line up.
  - Inputs:
    - Restrict the text-input rule to `input:not([type=checkbox]):not([type=radio]):not([type=range])`, fixing radio, range and ChoicePicker. Labels become `display: block` only for `label + input` text fields.
    - Placeholder colour, hover border, and an invalid state via `:invalid` / `[aria-invalid=true]` (do not rely on the literal `undefined` class).
    - CheckBox accent colour comes from `--accent`.
  - Lists and rows:
    - Item rows inside lists get a hover background (`--accent-soft` at low alpha) and rounded padding.
    - Under 600px: `.a2ui-root div[style*="flex-direction: row"] { flex-wrap: wrap !important; row-gap: var(--space-2); }`, so the 7-child item row wraps instead of overflowing.
    - `min-width: 0` on text children so long titles ellipsize.
  - `button.chip` and `.selected` get pill styling. Tabs get a header underline for the active tab.
  - Loading skeleton: `.a2ui-root div[style*="color: gray"]` gets `font-size: 0`, a shimmer block 12px high with `--radius-s` and a `@keyframes` gradient. Under reduced motion it is static.
  - Logging: none (CSS only).
  - Done when, in `?spike=1` (all four fixtures) and with the seeded control example, cards, headings, captions, inputs, checkboxes, chips and the skeleton look intentional in both themes; nothing overflows horizontally at 375px; and radio and range inputs are no longer full-width boxes.

- [x] **T9. Button variant classes (renderer fix for empty CSS modules)**
  - Create `a2ui/web/src/a2ui/catalog.ts`.
    - Build `appCatalog = new Catalog(<basic catalogId>, "0.9", components, BASIC_FUNCTIONS, BasicCatalogThemeSchema)`.
    - `components` is the exported basic set (`Text, Image, Icon, Video, AudioPlayer, Row, Column, List, Card, Tabs, Divider, Modal, Button, TextField, CheckBox, ChoicePicker, Slider, DateTimeInput`, in `index.js:1076-1096` order) with `Button` replaced by `VariantButton = createComponentImplementation(ButtonApi, …)`.
    - `VariantButton` renders `<button className={"a2ui-btn a2ui-btn--" + (props.variant ?? "default")} type="button" onClick={props.action} disabled={props.isValid === false}>`, with `buildChild(props.child)` as the content. That is behaviour identical to the original (`index.js:757-766`) plus classes and `type="button"`.
    - Read the catalogId from `basicCatalog.id`, or whichever property holds it (check the `Catalog` class in `@a2ui/web_core/v0_9`), instead of hard-coding it, and assert at module load that it equals the original. Log `info("catalog", "app catalog ready", {id, components: n})`.
    - Import `Catalog` from `@a2ui/web_core/v0_9` and `ButtonApi`, `BASIC_FUNCTIONS` and `BasicCatalogThemeSchema` from `@a2ui/web_core/v0_9/basic_catalog`. If an export is missing, stop and record it in the plan notes rather than copying library internals.
  - In `a2ui/web/src/a2ui/processor.ts:13`, use `[appCatalog]` instead of `[basicCatalog]`.
  - In `surface.css`:
    - `.a2ui-btn--primary`: filled accent, weight 600.
    - `.a2ui-btn--default`: outlined.
    - `.a2ui-btn--borderless`: text-only, accent colour, underline on hover.
    - Disabled state and `:active` press feedback.
  - Tests: create `a2ui/web/src/a2ui/__tests__/catalog.test.ts`. Assert that `appCatalog`'s id equals `basicCatalog`'s id and that the component name sets are equal (same 18 names). Importing React components under `node --test` with tsx must work without a DOM. If it does not, test a pure `variantClass(variant)` helper exported from `catalog.ts` instead, and cover the catalog equality in the T11 browser check.
  - Done when, with the seeded control example, "Сохранить" (primary), "Добавить" (default) and "Удалить" / "Напомнить" (borderless) are visually distinct, all actions still dispatch (click each action once in the T11 run), and `npm -w web run typecheck` passes.

- [x] **T10. Server: layout guide in the prompt, empty-state hints and surface theme**
  - View-model, in `a2ui/server/src/projector/view-model.ts`:
    - Add `hints: z.object({ people: z.string(), items: z.string(), editor: z.string(), transfers: z.string() }).strict()` to `BillViewModelSchema`.
  - `a2ui/server/src/projector/project.ts` fills these when the matching lists are empty and uses `""` otherwise:
    - `people`: "Добавьте участников — минимум двух."
    - `items`: "Пока нет позиций. Добавьте первую ниже."
    - `editor`: "Выберите позицию, чтобы настроить деление." (when no item is selected or there are none)
    - `transfers`: "Все в расчёте." (when there are no transfers but there are items)
  - Check that `a2ui/server/src/projector/diff.ts` emits per-field patches for `/hints/*` (extend it if diff works on an explicit field list). Log hint changes at debug through the existing `server/src/log.ts` (`debug("projector", "hints", hints)`).
  - Prompt, in `a2ui/server/src/agent/prompt.ts`: add a deterministic `LAYOUT_GUIDE` block between the A2UI rules and the catalog schema, delimited by `---BEGIN LAYOUT GUIDE---` / `---END LAYOUT GUIDE---`. Content, short imperative bullets in English with Russian UI labels:
    1. Root is a Column with this section order: header Row → errors → people Card → items Card → editor Card → summary Card.
    2. Every Card starts with a Text `h3` title ("Участники", "Позиции", "Редактор позиции", "Итог"). The client builds navigation from these headings, so do not skip them.
    3. Header Row uses `justify: "spaceBetween"`, `align: "center"`, title `h2` and the total `h3`.
    4. At most 4 direct children per Row inside list templates. Put secondary info (payer, split) in a caption Text inside a Column under the title, so rows fit a phone screen.
    5. Button variants:
       - exactly one `primary` per Card for its main action (Добавить / Добавить позицию / Сохранить);
       - `borderless` for destructive or secondary actions (Удалить, Напомнить, Исправить);
       - `default` otherwise.
    6. Use `Divider` between the list and the add form inside a Card.
    7. Bind a caption Text to `/hints/people`, `/hints/items`, `/hints/editor` and `/hints/transfers` at the top of the matching section. An empty string renders nothing.
    8. In the summary, add a header Row of caption Texts ("Участник", "Доля", "Платил", "Баланс") above the rows List, and put money texts last in each row.
    9. Short Russian labels, no emoji in buttons.
  - Update the embedded sample projection so it includes `hints`. It comes from the projector, so it should flow automatically; verify. Keep every existing marker and keep the output deterministic.
  - Reference tree, in `a2ui/server/src/debug/reference-tree.ts`: restructure it to follow the guide. This covers summary header row, Dividers, hint captions, the item row as Column(title Row + caption meta) with ≤4 children per Row, and the variants. It keeps every `KNOWN_ACTIONS` usage and stays valid.
  - Surface theme, in `a2ui/server/src/a2ui/envelopes.ts`:
    - Export `DEFAULT_THEME = { primaryColor: "#2f6f5e", agentDisplayName: "Split Bill" }`.
    - Pass `theme` for the `bill` surface in `agent/render-stream.ts:58` and `agent/tools.ts:196`. Other surfaces get `{ primaryColor }` only, so the client titles them by id (T5).
    - Log `debug("a2ui", "createSurface", {surfaceId, theme})`.
  - Tests:
    - `projector/__tests__/project.test.ts`: hints filled for an empty bill, cleared for the control example, and `editor` hint present when there are no items.
    - `projector/__tests__/diff.test.ts`: adding the first item clears `/hints/items` through a data patch.
    - `agent/__tests__/prompt.test.ts`: the guide markers are present, `/hints/items` is mentioned, the size stays under the 120k limit, and the output stays deterministic.
    - `debug/__tests__/reference-tree.test.ts`: still green; add an assertion that no Row inside a List template has more than 4 children.
    - `a2ui/__tests__/validate.test.ts`: `createSurface` with `DEFAULT_THEME` validates.
    - `agent/__tests__/tools.test.ts` and `render-stream.test.ts`: update any deep equality on the `createSurface` object.
  - Run `npm -w server run count:prompt` and note the new prompt size in REPORT (T12).
  - Implementation note: to keep ≤4 children per template Row, the summary row is name+«Напомнить» (Column) · Доля · Платил · Баланс, and the item row is Column(title row + caption meta row) · price · Открыть · Удалить. The `people` hint shows while there are fewer than two participants. Prompt grew from 50,814 to 53,060 chars (21,055 input tokens).
  - Done when `npm test` is green, `count:prompt` shows a modest increase (target < +3k tokens), and the seeded bill shows the hint captions and the restructured rows.

### Phase 5: Verification and docs

- [x] **T11. Visual and behavioural QA pass across the combination matrix**
  - Run `A2UI_DEBUG=1 npm run build && A2UI_DEBUG=1 npm -w server start` from `a2ui/`. Open http://localhost:8787 with the Playwright MCP. Seed with `POST /api/debug/seed` using the page's `sessionId` (from `sessionStorage["a2ui-session"]`).
  - Walk every row of the combination table in "Requirements Reconciliation" at 1440×900 and 375×812, in light and dark mode. Also check `?spike=1` (all four fixtures).
  - Click each action once on the seeded bill: add, rename and remove person (including the blocked removal and "Исправить"); add, open, delete and save an item; switch all three split types; change the payer. Check that the summary updates in place with no full redraw (debug drawer: no new `updateComponents`).
  - Run `npx @axe-core/cli` if available, otherwise the Playwright accessibility snapshot. There must be no unlabeled controls in the shell, and the tab bar, theme toggle and drawer must have correct roles.
  - If `ANTHROPIC_API_KEY` is set, also run `npm -w server run smoke:s1`. It must still report S6 `updateComponents = 0`. Then do one live S1 in the browser to see the model following the layout guide.
  - Save screenshots to `a2ui/docs/screenshots/` with these names: `desktop-light-bill.png`, `desktop-dark-bill-chart.png`, `mobile-light-chat.png`, `mobile-dark-bill.png`, `debug-drawer.png`. Fix any regressions found in the owning task's files before you tick this task.
  - Logging: confirm that `?debug=1` shows `[ui.*]` debug lines and that a normal load shows only warn and error lines.

- [x] **T12. Documentation: README, DEMO and REPORT**
  - `a2ui/README.md`: add a "Интерфейс" section covering the panes, mobile tab bar, theme toggle, debug mode (`?debug=1`, Ctrl/Cmd+Shift+D), keyboard shortcuts, and the screenshots from T11.
  - `a2ui/docs/DEMO.md`: update the demo walkthrough. It should say where to click on desktop and on mobile, that the drawer stays closed during the demo and is opened only to show envelopes or latency, and how to use the outline navigation during S5.
  - `a2ui/REPORT.md`:
    - "Кто автор UI" (`REPORT.md:13`): the model still authors the `bill` tree from the basic catalog. The prompt now carries a layout guide; the client adds a shell plus a Button implementation that only adds variant classes, with no new components.
    - "Контроль внешнего вида" (`REPORT.md:20`): what was achievable with tokens, CSS and renderer hooks; what needed the Button override (empty CSS modules in `@a2ui/react@0.12.0`); that `createSurface.theme` needs client code; the inline-style Row/List limits (`!important` for wrap); and the new prompt size from T10.
  - Logging: none.

## Commit Plan

- **Checkpoint 1** (after T1–T2): `feat(web): design tokens, theme switcher, prefs/logger and web test runner`
- **Checkpoint 2** (after T3–T6): `feat(web): sticky header, responsive panes with mobile tab bar, surface navigation and debug drawer`
- **Checkpoint 3** (after T7–T9): `feat(web): chat UX, surface stylesheet and button variant classes`
- **Checkpoint 4** (after T10): `feat(a2ui): layout guide in prompt, empty-state hints and surface theme`
- **Checkpoint 5** (after T11–T12): `docs(a2ui): UI guide, demo walkthrough, REPORT look-control findings and screenshots`

## Non-goals

- Replaying chat history after a reload (only `a2ui` and `status` events are replayed today, `server/src/http/sse.ts:25-26`). This needs a server change and is out of scope.
- New catalog components, custom functions, Tabs-based navigation inside the `bill` surface, or a chart component (S7 must stay an honest basic-catalog test).
- Fixing HMR for the `#` path.
