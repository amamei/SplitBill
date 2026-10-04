# Implementation Plan: A2UI Split Bill (hackathon participant #2)

Branch: feature/a2ui-split-bill
Created: 2026-10-04

Note: `main` had no commits when this branch was created, so the branch was made with `git checkout -b` (no base to pull). The first commit on this branch becomes the repository root commit.

## Original Request
A2UI Split Bill

## Settings
- Testing: yes
- Logging: verbose
- Docs: yes

## Research Context
Source: `.ai-factory/RESEARCH.md` (Active Summary, Updated: 2026-10-04 18:44, SHA256: adff82fce9cf0b77a29fa1b125ec48a092d84e27ea3ce0472cde623dde02e6e9)

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
Authority: `TZ.md` (domain contract §4, scenarios §5, control example §6) > `.ai-factory/RESEARCH.md` Active Summary (design decisions) > A2UI spec v0.9.1 + published packages (protocol constraints). User answers in this planning session resolved the open stack question: shared model = Claude via `@anthropic-ai/sdk`, thin Node/TS stack (no ADK/A2A).

Reconnaissance evidence used below comes from the upstream repo `a2ui-project/a2ui` (HEAD `1444719`) and `npm view` of the published 0.12.0 packages; paths are relative to that repo.

| Decision / supported combination | Source path and section | Verification evidence |
|----------------------------------|-------------------------|-----------------------|
| **Money units (refinement, not conflict).** Storage and domain API use integer minor units (TZ §3, §4 `price в минорных единицах`). User-facing numbers (chat, UI, tool inputs from the LLM) are major units with ≤2 decimals: the §6 edge case "позиция 100 поровну → 33.34 / 33.33 / 33.33" only holds if "100" is major units stored as 10000 minor. So "Еда 1200" is stored as 120000 and the §6 tables are read in major units. | `TZ.md` §3 rule 3, §4 `Item`, §6 "Проверки на края" | Domain test: control example entered as major units ×100 reproduces every §6 cell; rounding test 10000/3 → 3334/3333/3333 rendered "33.34/33.33/33.33" |
| Indivisible remainder goes 1 minor unit at a time to split participants **in `bill.people` order**, not in `personIds`/weights key order | `TZ.md` §4 rule 4 | Domain test with people order ≠ split order |
| Split type × edit channel (dimension table below) | `TZ.md` §4 rules 1–3, §5 S3/S4/S6 | Tests in tasks 5 and 8 |
| `exact` sum ≠ price → tool error with discrepancy; UI shows "не распределено N" | `TZ.md` §4 rule 2, §6 edge case | Domain test 590 vs 600 → diff 10 (minor 1000 → "10.00"); dispatch test sets `/editor/remainingText` |
| `remove_person` blocked while referenced; UI lists blocking items with a "fix" affordance | `TZ.md` §4 rule 5, §5 S2, §6 edge case | Domain test (Гена → `Еда`, `Чаевые`); dispatch test fills `/errors/removePerson/items` |
| UI tree is model-authored once (research option C); data pushed by code; S6 must emit **only** `updateDataModel` | RESEARCH Decisions; `TZ.md` §7 "Обновление на месте" | Message-type counters per turn in telemetry; smoke script asserts `updateComponents == 0` on the S6 turn |
| **UI emission channel: tool call `render_surface`, not `<a2ui-json>` text tags.** The Python SDK's direct_json format uses tags (`python/a2ui_agent/src/a2ui/schema/constants.py:88-89`); the spec is transport-agnostic. With Claude, tool inputs are guaranteed JSON, validation errors go back as `tool_result is_error` for self-repair, and S10 streaming uses `eager_input_streaming`. | Spec `docs/a2ui_protocol.md` (transport-agnostic); claude-api skill `typescript/claude-api/tool-use.md` | Validator tests; smoke S1 |
| **Visibility through data, refined to master–detail.** No conditional visibility exists in v0.9. Per-item split rows would need nested templates, which the renderer code supports but has **no tests for** (`typescript/web_core/src/resolution/node-resolver.test.ts` covers one level only). So the view model exposes a single always-visible `/editor` for the selected item with single-level templates `/editor/equalRows` etc. Empty lists render nothing (S2 error block). | RESEARCH Decisions ("visibility through data"); explorer finding §5 | Task 2 spike renders single-level templates + a nested one and records the result; projector tests |
| Relative paths in `event.context` inside a template resolve to the item scope (spec-sanctioned and tested) | Spec example `specification/v0_9_1/catalogs/basic/examples/00_incremental.json:116-118`; `typescript/web_core/src/resolution/data-context.test.ts:360-382` | Task 2 spike logs the resolved `ActionPayload.context` |
| Edits reach the server through action context bindings (`{"editor": {"path": "/editor"}}`, whole-object binding as in spec example `32_advanced-form-validator.json:142`); `sendDataModel: true` is also set and the client attaches `processor.getRendererDataModel('v0.9')` as `a2uiClientDataModel` — server prefers context, falls back to the attached model. (Refines the research line "TextFields + Save with sendDataModel".) | Spec `docs/a2ui_protocol.md:588`; `typescript/web_core/src/processing/message-processor.ts:354-407` | Dispatch tests for both inputs |
| Custom client functions: **none in v1** (research "tentative" resolved to the named fallback): remaining-to-distribute is computed server-side on `save_item` and shown in `/editor/remainingText`. | RESEARCH Decisions (fallback), `TZ.md` §7 "Кто автор UI" | Dispatch test |
| Every envelope carries `version: "v0.9"`; `catalogId` = `https://a2ui.org/specification/v0_9/catalogs/basic/catalog.json`; `createSurface` carries no components/data; one `createSurface` per surface id (re-render = `deleteSurface` + `createSurface`) | `specification/v0_9_1/json/server_to_client.json`; `renderers/react/src/v0_9/catalog/basic/index.ts:63-69`; `message-processor.ts:704-706` | Validator tests; client dedupe test in task 13 |
| Shared model = Claude; model id from `ANTHROPIC_MODEL` (default `claude-opus-5-5`), effort from `ANTHROPIC_EFFORT` (default `medium`) | `TZ.md` §3 "одна модель у всех"; user answer in planning | `.env.example`, README |
| Representative real artifacts in the verification path: TZ §6 control example as a fixture; upstream spec example JSON files run through our validator **and** rendered by the client shell; the receipt photo `photo_2026-10-04_18-36-09.jpg` (METRO, total 723.67) for S9 | `TZ.md` §6, §5 S9; `specification/v0_9_1/catalogs/basic/examples/` | Tasks 2, 6, 14 |

Supported combinations — split type × edit channel (both channels end in the same domain call `update_item`):

| Split type | Accepted input | Persisted state | Output / next transition | Side effects & invariants | Verification |
|---|---|---|---|---|---|
| `equal` | UI: `/editor/equalRows[].included` checkboxes + `save_item`; chat: "поровну на всех/на Аню и Борю" → `update_item(split:{type:"equal", personIds})` | `Split{type:"equal", personIds}` (non-empty) | diffed `updateDataModel("bill", <changed paths>)`; shares recomputed with remainder rule 4 | Sum of shares == price; people not in `personIds` get 0 | Domain test (1200/4, 100/3); dispatch test toggling a checkbox |
| `exact` | UI: `/editor/exactRows[].amountText` strings (major units) + `save_item`; chat: "суммы: Аня 250, Боря 250, Вика 100" → `update_item(split:{type:"exact", amounts})` | `Split{type:"exact", amounts}` only if Σ == price | On mismatch: domain error `EXACT_MISMATCH {expected, actual, diff}`; UI → `/editor/remainingText = "Не распределено 10.00"`, state unchanged; chat → tool `is_error`, model explains | Σ amounts == price invariant; zero/omitted persons allowed | Domain test 590 vs 600; dispatch test error path and success path |
| `shares` | UI: `/editor/sharesRows[].weightText` positive integers + `save_item`; chat: "доли: Аня 2, Боря 1, Вика 1" / S6 "Гена тоже курил, одна доля" → `update_item(split:{type:"shares", weights})` | `Split{type:"shares", weights}` (all weights ≥ 1 integers) | shares = floor(price·w/W) + remainder by people order | Σ shares == price; non-integer/≤0 weight → `INVALID_WEIGHT` error | Domain test 800 with 2/1/1 → 400/200/200 and 2/1/1/1 → 320/160/160/160 |
| any → switch type | UI: `set_split_type {type}` button in editor | Split replaced with defaults: `equal` = all people; `exact` = all amounts 0 (invalid until saved — state keeps previous split until a valid save); `shares` = weight 1 each | VM switches which `*Rows` list is non-empty | Switching never changes totals until `save_item` succeeds | Dispatch test: after `set_split_type exact`, `exactRows` filled, others empty |

## Commit Plan
- **Commit 1** (after tasks 1–2): "feat(a2ui): scaffold workspace and render first A2UI surface in React shell"
- **Commit 2** (after tasks 3–5): "feat(a2ui): split-bill domain with control-example tests"
- **Commit 3** (after tasks 6–7): "feat(a2ui): v0.9 message validator, envelope builders and view-model projector"
- **Commit 4** (after tasks 8–12): "feat(a2ui): Claude agent with render_surface tool, action dispatch, SSE server and streaming"
- **Commit 5** (after tasks 13–15): "feat(a2ui): web client integration, S1 bench scripts, README and REPORT skeleton"

## Architecture (reference for all tasks)

```
a2ui/                               # TZ §8: one folder per tool, one-command run
  package.json                      # npm workspaces: server, web; `npm run dev` starts both
  .env.example                      # ANTHROPIC_API_KEY, ANTHROPIC_MODEL, ANTHROPIC_EFFORT, LOG_LEVEL, PORT, A2UI_STREAM
  README.md  REPORT.md
  server/  (Node 26, TypeScript ESM, tsx, vitest, express 5, @anthropic-ai/sdk, zod, ajv, ajv-formats)
    src/log.ts                      # leveled logger, LOG_LEVEL env, "[Comp.method] msg {json}"
    src/domain/{types,money,allocate,store,summary,errors}.ts      # TZ §4 contract, minor-unit ints
    src/a2ui/spec/v0_9/*.json       # vendored spec: server_to_client, common_types, catalog, examples
    src/a2ui/{validate,envelopes,stream-extract}.ts
    src/projector/project.ts        # Bill -> BillViewModel (strings preformatted)
    src/agent/{prompt,tools,session,actions,telemetry}.ts
    src/http/{server,sse,sessions}.ts
    scripts/{smoke-s1,bench-s1}.ts
  web/     (Vite, React 19, @a2ui/react 0.12, @a2ui/web_core 0.12, @a2ui/markdown-it, zod)
    src/{main,App}.tsx  src/a2ui/{processor,api}.ts  src/components/{Chat,MessageLog,Surfaces}.tsx  src/a2ui.css

Runtime flow
  chat text ──POST /api/chat──▶ agent session (Claude tool runner, stream:true)
       tools: create_bill … get_summary (domain)  +  render_surface (UI)
       domain tool ⇒ store mutates ⇒ projector ⇒ diffViewModel ⇒ SSE a2ui: updateDataModel("bill", <changed paths>)
       render_surface ⇒ validate ⇒ SSE a2ui: [deleteSurface?] createSurface, updateComponents, updateDataModel
  UI click ──POST /api/action {version, action, a2uiClientDataModel}──▶ dispatch table
       known action ⇒ domain ⇒ projector ⇒ diffViewModel ⇒ updateDataModel (no model round trip)
       unknown action (e.g. remind) ⇒ forwarded to the agent as a user message (S8)
  SSE /api/events: a2ui | chat | status(tokens, latency, message counts) | error
```

View model contract (`BillViewModel`, produced only by the projector; the system prompt embeds its JSON Schema and a sample projection of the control example):

```jsonc
{
  "bill":    { "title": "Bermuda", "currency": "MDL", "totalText": "2860.00" },
  "people":  [ { "id": "p1", "name": "Аня" } ],
  "draft":   { "personName": "", "itemTitle": "", "itemPrice": "" },
  "items":   [ { "id": "i2", "title": "Кальяны", "priceText": "800.00", "payerName": "Аня", "splitText": "доли: Аня 2, Боря 1, Вика 1", "isSelectedText": "▶" } ],
  "editor":  { "itemId": "i2", "title": "Кальяны", "priceText": "800.00", "payerId": "p1", "payerName": "Аня",
               "splitType": "shares", "splitTypeText": "Доли",
               "payerOptions": [ { "id": "p1", "name": "Аня", "markText": "●" } ],
               "equalRows":  [],                                                   // only the active type's list is non-empty
               "exactRows":  [],
               "sharesRows": [ { "personId": "p1", "name": "Аня", "weightText": "2", "shareText": "400.00" } ],
               "remainingText": "", "error": "" },
  "summary": { "rows": [ { "personId": "p3", "name": "Вика", "owesText": "665.00", "paidText": "260.00", "balanceText": "−405.00" } ],
               "transfers": [ { "fromId": "p3", "toId": "p1", "text": "Вика → Аня 385.00", "amountText": "385.00" } ] },
  "errors":  { "removePerson": { "message": "", "items": [ { "itemId": "i1", "title": "Еда" } ] } }
}
```

Action contract (server dispatch table; the system prompt publishes exactly this list — the model must use these names and context keys when authoring the `bill` surface):

| Action name | Context (resolved by the client) | Server behavior |
|---|---|---|
| `add_person` | `{ "name": {"path": "/draft/personName"} }` | `store.addPerson`; clears draft; re-project |
| `rename_person` | `{ "personId": {"path": "id"}, "name": {"path": "name"} }` (inside `/people` template; `name` is the two-way bound TextField) | `store.renamePerson` |
| `remove_person` | `{ "personId": {"path": "id"} }` | on `PERSON_REFERENCED` error → `/errors/removePerson = {message, items}`; success clears it |
| `add_item` | `{ "title": {"path": "/draft/itemTitle"}, "price": {"path": "/draft/itemPrice"} }` | parse major→minor; `store.addItem` (equal on all people); select it in editor |
| `select_item` | `{ "itemId": {"path": "id"} }` | sets `session.selectedItemId`; re-project |
| `remove_item` | `{ "itemId": {"path": "id"} }` | `store.removeItem`; selection moves to first remaining |
| `set_split_type` | `{ "type": "equal" \| "exact" \| "shares" }` (literal) | per combination table above |
| `set_payer` | `{ "personId": {"path": "id"} }` (inside `/editor/payerOptions` template) | `store.updateItem(paidById)` |
| `save_item` | `{ "editor": {"path": "/editor"} }` | parse title/price/rows → `store.updateItem`; errors → `/editor/error` + `/editor/remainingText` |
| `fix_item` | `{ "itemId": {"path": "itemId"} }` (inside `/errors/removePerson/items`) | same as `select_item` |
| anything else (e.g. `remind`) | free | forwarded to the agent: `[UI action] <name> <json context>` (S8) |

## Tasks

### Phase 1: Scaffold and first pixels (target: rendered screen well before the TZ 1:30 cutoff)

- [x] Task 1: Scaffold the `a2ui/` npm workspace (server + web) with tooling, env handling and the logger
  - Create `a2ui/package.json` with `"workspaces": ["server", "web"]`, `"private": true`, scripts: `dev` = `concurrently -n server,web "npm -w server run dev" "npm -w web run dev"`, `test` = `npm -w server test`, `build` = `npm -w server run build && npm -w web run build`, `typecheck`. Dev dependency `concurrently`. Node ≥ 22 engines field (machine has Node 26.7 / npm 12; no yarn/pnpm).
  - `a2ui/server/package.json`: `"type": "module"`, scripts `dev` = `tsx watch src/http/server.ts`, `test` = `vitest run`, `build` = `tsc -p tsconfig.json`; deps `@anthropic-ai/sdk` (0.131+; peer `zod ^3.25.0 || ^4.0.0`, so Zod 3 on the server is fine and matches `@a2ui/react`'s peer), `express` (5.x), `zod` (^3.25), `zod-to-json-schema` (^3.25, used by task 7), `ajv` (^8), `ajv-formats` (^3); dev deps `typescript` (^5.9), `tsx`, `vitest`, `@types/express`, `@types/node`. `tsconfig.json`: `"module": "NodeNext"`, `"moduleResolution": "NodeNext"`, `"target": "ES2022"`, `"strict": true`, `"outDir": "dist"`, `"rootDir": "src"`. Use `import.meta.url` + `fileURLToPath` for file paths (ESM; `__dirname` is undefined).
  - `a2ui/web/`: `npm create vite@latest` equivalent files for React + TypeScript (`index.html`, `vite.config.ts`, `tsconfig.json`, `src/main.tsx`, `src/App.tsx`); deps `react` 19, `react-dom` 19, `@a2ui/react@0.12.0`, `@a2ui/web_core@0.12.0`, `@a2ui/markdown-it@0.2.0`, `zod@^3.25.76` (peer dep of `@a2ui/react`). `vite.config.ts` proxies `/api` → `http://localhost:8787` (SSE needs `proxy["/api"].ws = false` and no buffering; Vite's http-proxy passes event-stream through by default).
  - `a2ui/.env.example`: `ANTHROPIC_MODEL=claude-opus-5-5`, `ANTHROPIC_EFFORT=medium`, `LOG_LEVEL=debug`, `PORT=8787`, `A2UI_STREAM=1`, and a commented-out `# ANTHROPIC_API_KEY=` (optional). **Credentials come from the `ant` CLI profile by default**: the machine has `ant` 1.38.0 installed (Homebrew `anthropics/tap/ant`), and the user authenticates once with `ant auth login`; the zero-arg `new Anthropic()` client resolves `ANTHROPIC_API_KEY` → `ANTHROPIC_AUTH_TOKEN` → the active `ant` profile, so no key is stored in the repo. Do **not** set an empty `ANTHROPIC_API_KEY=` line uncommented — an empty key can shadow the profile. Server loads `../.env` at startup with `process.loadEnvFile(path)` inside try/catch (Node ≥ 21.7; no dotenv dependency). `.gitignore` in `a2ui/`: `node_modules`, `dist`, `.env`.
  - `a2ui/server/src/log.ts`: `log.debug/info/warn/error(scope, message, data?)`, level from `LOG_LEVEL` (default `info`; `.env.example` sets `debug`), output `[scope] message {json}` to stderr with ISO timestamp; `data` JSON is truncated to 2 KB per line with a `…(truncated N chars)` suffix so A2UI payloads stay readable. Export `createScope(name)` returning bound methods.
  - Verify: `cd a2ui && npm install && npm run typecheck` passes; `npm run dev` starts both processes (web prints the Vite URL, server logs `[http.server] listening {port}` even with no routes yet).
  - LOGGING: server startup logs resolved config (model, effort, port, stream flag, log level) at INFO, plus the credential source as a label only (`env:ANTHROPIC_API_KEY` / `env:ANTHROPIC_AUTH_TOKEN` / `ant-profile`) — never the secret. If none resolves, the first API call raises `Anthropic.AuthenticationError`; surface it as "Run `ant auth login`" in the `error` SSE event (task 10).
  - Files: `a2ui/package.json`, `a2ui/.env.example`, `a2ui/.gitignore`, `a2ui/server/{package.json,tsconfig.json,src/log.ts,src/http/server.ts (placeholder)}`, `a2ui/web/{package.json,tsconfig.json,vite.config.ts,index.html,src/main.tsx,src/App.tsx}`.

- [x] Task 2: React shell that renders hardcoded A2UI v0.9 messages, plus the renderer spikes (depends on 1)
  - `web/src/a2ui/processor.ts`: create once `new MessageProcessor<ReactComponentImplementation>([basicCatalog], onAction)` with `MessageProcessor` from `@a2ui/web_core/v0_9` and `basicCatalog`, `A2uiSurface`, `ReactComponentImplementation`, `MarkdownContext` from `@a2ui/react/v0_9`; `renderMarkdown` from `@a2ui/markdown-it`. Export `feed(messages)` that wraps `processor.processMessages(messages)` in try/catch (it is synchronous and throws `A2uiValidationError` / `A2uiIntegrityError` / `A2uiCatalogError` on the first bad message) and skips a `createSurface` whose `surfaceId` already exists in `processor.model.surfacesMap` (dedupe; a second `createSurface` throws "already exists").
  - `web/src/components/Surfaces.tsx`: keep surfaces in state seeded from `processor.model.surfacesMap`, subscribe with `processor.onSurfaceCreated` / `onSurfaceDeleted` (both return `{unsubscribe}`), render `surfaces.map(s => <A2uiSurface key={s.id} surface={s} />)` inside `<MarkdownContext.Provider value={renderMarkdown}>`.
  - `web/src/a2ui.css`: the published 0.12.0 `@a2ui/react` build ships **empty CSS-module maps** for Button, Text, TextField and ChoicePicker (class names resolve to `""`), while Row/Column/List use inline styles and the `--a2ui-*` variables are injected automatically via `document.adoptedStyleSheets`. So style with element selectors scoped under `.a2ui-root` (`button`, `input`, `textarea`, `label`, `p`, `h1-h3`) using the `--a2ui-*` variables (`--a2ui-color-primary`, `--a2ui-border-radius`, `--a2ui-spacing-*`, …) and override the variables for our palette on `.a2ui-root` (the React renderer does not apply `createSurface.theme`; only Lit does). Record this in REPORT's "Контроль внешнего вида" / log of затыки. Fallback if the result is unusable: Vite `resolve.alias` of `@a2ui/react/v0_9` to a vendored copy of `renderers/react/src/v0_9` (the upstream `a2ui_explorer` does this) — not planned unless needed.
  - `web/src/fixtures/spike.ts`: hardcoded message arrays (every envelope has `version: "v0.9"`; catalogId `https://a2ui.org/specification/v0_9/catalogs/basic/catalog.json`; `createSurface` → `updateComponents` → `updateDataModel`):
    1. Single-level List template over `/items` with a Row containing `Text{path:"title"}` and a Button whose action is `{"event":{"name":"select_item","context":{"itemId":{"path":"id"}}}}` — expect `ActionPayload.context.itemId` to be the item's id (note `sourceComponentId` is the template id, shared by all rows).
    2. A nested template (`/items[]` → `rows[]`) — **spike only**: record whether it renders and resolves; the production VM does not depend on it.
    3. `TextField` two-way bound to `/editor/title`, a `CheckBox` bound to `/editor/flag`, and a Button with context `{"editor":{"path":"/editor"}}` — expect the typed values in `context.editor`.
    4. Two upstream example files copied verbatim: `34_child-list-template.json` and `00_incremental.json` (from `specification/v0_9_1/catalogs/basic/examples/`) — they must render without throwing.
  - Add a `?spike=1` query switch in `App.tsx` that feeds the fixtures and shows a `<pre>` of the last `ActionPayload` plus `JSON.stringify(processor.getRendererDataModel('v0.9'))` (available only for surfaces created with `sendDataModel: true` — set it in fixture 3).
  - Write the spike outcomes (what rendered, what resolved, console errors) to `a2ui/REPORT.md` under a "Spike log" heading (create the file with only that heading now; task 15 fills the rest).
  - LOGGING: `console.debug("[a2ui.processor] feed", {count, types})` per batch; `console.info("[a2ui.action]", payload)`; `console.error("[a2ui.processor] rejected", err, message)`.
  - Files: `a2ui/web/src/a2ui/processor.ts`, `a2ui/web/src/components/Surfaces.tsx`, `a2ui/web/src/fixtures/spike.ts`, `a2ui/web/src/a2ui.css`, `a2ui/web/src/App.tsx`, `a2ui/REPORT.md`.
<!-- Commit checkpoint: tasks 1-2 -->

### Phase 2: Domain — code computes money (TZ §4)

- [x] Task 3: Domain types, money parsing/formatting and share allocation (depends on 1)
  - `server/src/domain/types.ts`: `Person {id, name}`, `Split = {type:"equal", personIds: string[]} | {type:"exact", amounts: Record<string, number>} | {type:"shares", weights: Record<string, number>}`, `Item {id, title, price, paidById, split}` (price = integer minor units), `Bill {id, title, currency, people, items}`. Zod schemas for the same shapes (`SplitSchema`, `ItemPatchSchema`) exported for tool input validation.
  - `server/src/domain/money.ts`: `parseMajor(input: string | number): number` → minor units; accepts `"1200"`, `"33.5"`, `"33,50"`, `"1 200.00"`; rejects >2 decimals, negatives, NaN with `DomainError("INVALID_AMOUNT")`; `formatMinor(n, {sign?: boolean}): string` → `"1200.00"`, `"−405.00"` (U+2212 minus for display, as in TZ tables); `MINOR_PER_MAJOR = 100`.
  - `server/src/domain/allocate.ts`: `allocate(item: Item, peopleOrder: string[]): Record<personId, minor>` implementing TZ rules 1–4: `equal` floor + remainder 1 unit each in `peopleOrder` restricted to participants; `exact` must sum to price else `DomainError("EXACT_MISMATCH", {expected, actual, diff})`; `shares` floor(price·w/W) + remainder in `peopleOrder`; weights must be positive integers else `DomainError("INVALID_WEIGHT")`; unknown personId → `DomainError("UNKNOWN_PERSON")`. Pure, no floats (integer arithmetic only; use `BigInt` only if products could exceed 2^53 — they cannot for hackathon sizes, assert instead).
  - `server/src/domain/errors.ts`: `class DomainError extends Error { code; details }` with codes `INVALID_AMOUNT | EXACT_MISMATCH | INVALID_WEIGHT | UNKNOWN_PERSON | PERSON_REFERENCED | NOT_FOUND | EMPTY_SPLIT | DUPLICATE_NAME?` and `toJSON()` for tool results.
  - LOGGING: `allocate` logs at DEBUG `[domain.allocate] {itemId, type, price, result}`; errors at WARN with code/details.
  - Files: `a2ui/server/src/domain/{types,money,allocate,errors}.ts`.

- [x] Task 4: In-memory `BillStore` with the eight TZ tools and the summary/settlement algorithm (depends on 3)
  - `server/src/domain/store.ts`: `class BillStore` with `createBill(title, currency = "MDL", people: string[], items: NewItem[])`, `addPerson(billId, name)`, `renamePerson(billId, personId, name)`, `removePerson(billId, personId)` (throws `PERSON_REFERENCED` with `details.items = [{id, title, role: "payer" | "participant"}]` when the person is `paidById` or appears in `equal.personIds` / `exact.amounts` / `shares.weights`), `addItem(billId, {title, price, paidById, split?})` (no split → `equal` on all current people; rule 1), `updateItem(billId, itemId, patch)` (validates the **resulting** item through `allocate` before committing; rule 2), `removeItem`, `getBill`, `getSummary(billId)`. Ids: `p1..`, `i1..` per bill (short, stable, model-friendly). New people never join existing items (rule 5 second sentence). People are matched by exact name in tools that accept names (tool layer resolves names → ids; see task 10).
  - `server/src/domain/summary.ts`: `summarize(bill): Summary` = per-person `owes` (Σ allocations), `paid` (Σ prices where payer), `balance = paid − owes`, `total`, and `settle(balances): Transfer[]` using greedy largest-debtor → largest-creditor matching (each step zeroes at least one side ⇒ ≤ N−1 transfers; deterministic ordering by amount desc then people order). Also return the per-item allocation matrix for the TZ §6 table.
  - LOGGING: every mutating method logs INFO `[domain.store.<method>] {billId, args}` and DEBUG the resulting bill size; `getSummary` logs DEBUG balances and transfer count.
  - Files: `a2ui/server/src/domain/{store,summary}.ts`, `a2ui/server/src/domain/index.ts` (barrel).

- [x] Task 5: Domain tests for the control example and edge cases (depends on 4)
  - `server/src/domain/fixtures/control-example.ts` (production-importable, **not** under `__tests__/` — task 9 embeds a projection of it in the system prompt): `buildControlExample(store): {billId, ids}` builds the TZ §6 bill via the store API with major-unit inputs ×100: people Аня, Боря, Вика, Гена; Еда 1200 Боря equal all; Кальяны 800 Аня shares Аня 2/Боря 1/Вика 1; Вино 600 Аня exact Аня 250/Боря 250/Вика 100; Чаевые 260 Вика equal all.
  - `control-example.test.ts` asserts the full §6 matrix (Аня 300/400/250/65 owes 1015 paid 1400 balance +385; Боря 300/200/250/65 → 815/1200/+385; Вика 300/200/100/65 → 665/260/−405; Гена 300/0/0/65 → 365/0/−365; totals 2860), transfers: exactly 3, balances sum to 0, applying the transfers zeroes every balance (do not assert the specific pairing — TZ allows variants). Then S6: `updateItem(hookah, {split: shares {Аня 2, Боря 1, Вика 1, Гена 1}})` → 320/160/160/160 and balances +465/+425/−365/−525.
  - `edge-cases.test.ts`: (a) 100 equal on Аня/Боря/Вика → 3334/3333/3333 and `formatMinor` → "33.34"/"33.33"/"33.33"; (b) exact 250+250+90 on price 600 → `EXACT_MISMATCH` with `diff = 1000` (formatted "10.00") and the message text contains "не распределено 10.00"; (c) `removePerson(Гена)` on the control example → `PERSON_REFERENCED` listing items titled "Еда" and "Чаевые" and nothing else; (d) remainder order follows `bill.people`, not split key order; (e) `addPerson` after items exist does not change any allocation; (f) weights `0`/`1.5` rejected; (g) `parseMajor` matrix.
  - Run: `npm -w server test` green. Keep tests free of LLM/network.
  - LOGGING: none beyond the code under test (tests set `LOG_LEVEL=error` via `vitest.config.ts` `env`).
  - Files: `a2ui/server/src/domain/fixtures/control-example.ts`, `a2ui/server/src/domain/__tests__/{control-example.test.ts,edge-cases.test.ts}`, `a2ui/server/vitest.config.ts`.
<!-- Commit checkpoint: tasks 3-5 -->

### Phase 3: A2UI server layer

- [x] Task 6: Vendor the v0.9 spec, build the message validator and envelope builders (depends on 1)
  - Vendor into `server/src/a2ui/spec/v0_9/`: `server_to_client.json`, `common_types.json`, `client_to_server.json`, `client_data_model.json` from upstream `specification/v0_9_1/json/`, `catalog.json` from `specification/v0_9_1/catalogs/basic/`, and examples `00_incremental.json`, `09_login-form.json`, `13_coffee-order.json`, `32_advanced-form-validator.json`, `34_child-list-template.json` from `specification/v0_9_1/catalogs/basic/examples/`. Source: `git clone --depth 1 https://github.com/a2ui-project/a2ui.git` (or raw GitHub URLs on `main`); add `SOURCE.md` with the upstream commit. Do **not** take `catalogs/basic/v1/*` (that is the v1.0 protocol with `@path`/`@call`).
  - `server/src/a2ui/validate.ts`: `Ajv2020` (`import Ajv2020 from "ajv/dist/2020.js"`) with `strict: false`, `addFormats`. Both `ajv` and `ajv-formats` are CommonJS; under `"moduleResolution": "NodeNext"` their default import arrives wrapped, so unwrap before use: `const Ajv = (Ajv2020 as any).default ?? Ajv2020; const addFormatsFn = (addFormats as any).default ?? addFormats;` (calling the wrapper directly fails with "is not a constructor" / "is not a function"). `addSchema` for `common_types.json`, for `catalog.json` **re-registered under `$id` `https://a2ui.org/specification/v0_9/catalog.json`** (the spec's `server_to_client.json` references a relative `catalog.json`; upstream `run_tests.py` does the same aliasing) and for `server_to_client.json`. Export `validateEnvelope(msg)` and `validateComponents(components)`: schema validation + topology checks: exactly one `id: "root"`; ids unique; every reference resolves (children arrays, template `componentId`, `Card.child`, `Button.child`, `Tabs[].child`, `Modal.trigger/content`); no orphans other than `root`; `event.context` keys present. Return `{ok: true} | {ok: false, errors: Array<{path, message}>}` with ajv errors condensed to the `oneOf` branch matching the single operation key (the raw `oneOf` output is too noisy to feed back to a model).
  - `server/src/a2ui/envelopes.ts`: `createSurface(surfaceId, {sendDataModel = true, theme?})`, `updateComponents(surfaceId, components)`, `updateDataModel(surfaceId, value, path = "/")`, `deleteSurface(surfaceId)` — all with `version: "v0.9"` and `CATALOG_ID` constant; `type A2uiEnvelope`.
  - Tests `server/src/a2ui/__tests__/validate.test.ts`: every vendored example's `messages[]` validates; mutations fail with a readable error: missing `version`, missing `root`, dangling child id, duplicate id, unknown component `"Chart"`, `createSurface` carrying `components` (v1.0 shape), `checks` written as `{call,args,message}` instead of `{condition,message}`.
  - LOGGING: `[a2ui.validate] ok {surfaceId, components}` DEBUG; failures WARN with the condensed error list.
  - Files: `a2ui/server/src/a2ui/spec/v0_9/*`, `a2ui/server/src/a2ui/{validate,envelopes}.ts`, `a2ui/server/src/a2ui/__tests__/validate.test.ts`.

- [x] Task 7: Projector `Bill → BillViewModel` (depends on 4, 6)
  - `server/src/projector/view-model.ts`: TypeScript type + Zod schema `BillViewModelSchema` for the contract in the Architecture section (also serialized to JSON Schema for the system prompt with `zod-to-json-schema` or `z.toJSONSchema` if on Zod 4 — pin to whichever Zod major is installed; `@a2ui/react` peers on `^3.25.76`, so use Zod 3 + `zod-to-json-schema`).
  - `server/src/projector/project.ts`: `projectBill(bill, ui: {selectedItemId?: string, draft?: Draft, errors?: UiErrors, editorError?: {message, remainingText}}): BillViewModel`. Rules: all money as `formatMinor` strings; `items[].splitText` in Russian ("поровну: все" / "поровну: Аня, Боря" / "суммы: Аня 250.00, …" / "доли: Аня 2, …"); `editor` always present — selected item defaults to the first item; when the bill has no items, editor fields are empty strings and all row lists empty; exactly one of `equalRows/exactRows/sharesRows` non-empty according to `editor.splitType`; `equalRows[].included` boolean; `exactRows[].amountText` from the current amounts (`"0.00"` for persons not in `amounts`); `sharesRows[].weightText` (`"0"` for absent — treated as excluded on save); `payerOptions[].markText` = `"●"` for the current payer else `""`; `summary` from `summarize`; `errors.removePerson` from `ui.errors` or empty.
  - `server/src/projector/diff.ts`: `diffViewModel(prev: BillViewModel | undefined, next: BillViewModel): Array<{path: string, value: unknown}>` — `prev` undefined → `[{path: "/", value: next}]`; otherwise one entry per changed top-level key (`/bill`, `/people`, `/items`, `/summary`, `/errors`) compared by deep equality, and **per field** inside `/editor` and `/draft` (e.g. `/editor/payerOptions`, `/editor/remainingText`, `/draft/personName`), except that a change of `/editor/itemId` or `/editor/splitType` replaces the whole `/editor`. Purpose: a server push must not overwrite fields the user is typing but has not saved (unsaved `/editor/*Rows` edits, other draft inputs) — A2UI inputs live only in the client data model until an action fires.
  - Tests `project.test.ts` on the control example: snapshot-free assertions of key fields (people count, `items[1].splitText`, editor rows for each split type after switching `selectedItemId`, summary row for Вика `balanceText === "−405.00"`, transfers length 3, `errors.removePerson.items` empty), and the invariant "exactly one rows list non-empty". `diff.test.ts`: first diff is `/`; changing only the payer yields `/editor/payerOptions`, `/editor/payerId`, `/editor/payerName`, `/items`, `/summary` and nothing under `/editor/exactRows`; switching selection yields a single `/editor` entry; identical VMs yield `[]`.
  - LOGGING: DEBUG `[projector.projectBill] {billId, items, selected, splitType}`; DEBUG `[projector.diff] {paths}`.
  - Files: `a2ui/server/src/projector/{view-model,project,diff}.ts`, `a2ui/server/src/projector/__tests__/{project,diff}.test.ts`.
<!-- Commit checkpoint: tasks 6-7 -->

### Phase 4: Agent, action dispatch, HTTP

- [x] Task 8: Action dispatch table — UI actions become domain calls without a model round trip (depends on 7)
  - `server/src/agent/actions.ts`: `dispatchAction(session, action: ActionPayload, clientDataModel?): DispatchResult` where `DispatchResult = {kind: "handled", envelopes: A2uiEnvelope[]} | {kind: "forward", userMessage: string}`. Implement the Action contract table from the Architecture section. Input resolution helper `pick(action.context, clientDataModel?.surfaces?.bill, path)`: prefer the context value; fall back to the attached data model when the context key is missing. `save_item`: parse `editor.title`, `editor.priceText` (`parseMajor`), and depending on `editor.splitType`: `equalRows` → `personIds` of `included === true` (empty → `EMPTY_SPLIT`), `exactRows` → `amounts` from `amountText` (skip `"0.00"`/empty), `sharesRows` → `weights` from `weightText` (skip `"0"`/empty). On `DomainError` the result is still `handled`: set `ui.editorError = {message, remainingText}` where `remainingText = "Не распределено " + formatMinor(diff)` for `EXACT_MISMATCH` (negative diff → "Перебор на …"), then re-project. `remove_person` failure → `ui.errors.removePerson = {message: "Нельзя удалить: участник есть в позициях", items}`; any later successful action clears it. After every handled action: `next = projectBill(...)`; `envelopes = diffViewModel(session.lastVm, next).map(d => updateDataModel("bill", d.value, d.path))`; `session.lastVm = next` (no envelope when the diff is empty). Unknown action → `forward` with `[UI action] ${name} ${JSON.stringify(context)}`.
  - `server/src/agent/session.ts` (state only, runner comes in task 10): `Session {id, store, billId?, ui: {selectedItemId?, draft, errors, editorError}, lastVm?: BillViewModel, modelSeenVersion: number, messages: BetaMessageParam[], telemetry: TurnTelemetry[]}`; the store keeps a `version` counter bumped on every successful mutation (add to `BillStore` in task 4's file if not already present) and `SessionRegistry.get(id)` (creates on first use).
  - Tests `actions.test.ts` (control example loaded into a session): `select_item` switches editor; `set_split_type exact` → `exactRows` populated, others empty, totals unchanged; `save_item` with exact 250/250/90 → editor `remainingText === "Не распределено 10.00"` and bill unchanged; with 250/250/100 → saved; `set_payer`; `remove_person` Гена → `errors.removePerson.items` titles `["Еда","Чаевые"]`; `fix_item` selects Еда; `add_person "Дима"` → people 5, allocations unchanged; `rename_person` via relative context; `remind {personId}` → `forward`; context missing but `a2uiClientDataModel` present → still handled. Assert each handled result emits only `updateDataModel` envelopes (≥ 1 when state changed) and zero `updateComponents` (S6/S2–S5 evidence); `set_payer` emits nothing under `/editor/exactRows` (unsaved inputs survive).
  - LOGGING: INFO `[agent.actions.dispatch] {session, name, context}`; WARN on `DomainError` with code; INFO `[agent.actions.forward]` for unknown actions.
  - Files: `a2ui/server/src/agent/{actions,session}.ts`, `a2ui/server/src/agent/__tests__/actions.test.ts`.

- [x] Task 9: System prompt builder — A2UI rules, schema block, examples, view-model and action contracts (depends on 5, 6, 7)
  - `server/src/agent/prompt.ts` exporting `buildSystemPrompt(): string` assembled **deterministically** (no timestamps, sorted keys) so it caches; sections in this order:
    1. Role: Russian-speaking split-bill assistant; money is computed by tools, never by the model; amounts the user says are major units (lei) — pass them as decimal strings to tools.
    2. Workflow: for a new bill call `create_bill` (then other domain tools as needed), then call `render_surface` **once** for `surfaceId: "bill"`; after any later domain tool call the `bill` surface data refreshes automatically — do not call `render_surface` again unless the user asks for a different screen; for unplanned requests (chart, reminder text) create a new surface id (e.g. `chart-1`) and pass your own `data`; after tools, answer in one or two short sentences.
    3. A2UI v0.9 rules (hand-written; the Python SDK's `DEFAULT_WORKFLOW_RULES` plus the gaps the explorer found): every message is built by the server — the model only supplies `components` (flat array) and optional `data`; `root` first, parents before children; children are referenced by id (`children: ["a","b"]` or `{ "componentId": "tpl", "path": "/list" }`), never inline; `Card`/`Button` take `child`; `Tabs.tabs[]` `{title, child}`; data binding `{"path": "/abs"}`, relative paths only inside templates; `TextField`/`CheckBox` `value` bind two-way; `ChoicePicker.value` is an array of strings and `options` are static — prefer Button lists over templates for people; `checks` = `[{ "condition": {"call": "required", "args": {...}}, "message": "…" }]`; actions `{"event": {"name", "context"}}` with literal values unless bound; **no conditional visibility — empty lists render nothing**; numbers/currency are preformatted strings in the data — bind them with `Text`, do not use `formatCurrency`; `weight` (number) distributes space in a `Row`/`Column`.
    4. The A2UI schema block exactly as the Python SDK renders it: `---BEGIN A2UI JSON SCHEMA---`, `### Catalog Schema:` + minified `catalog.json`, `### Common Types Schema:` + minified `common_types.json`, `---END A2UI JSON SCHEMA---` (omit `server_to_client.json`: the model never writes envelopes).
    5. `### Examples:` two vendored examples' `components` arrays (`34_child-list-template.json`, `00_incremental.json`) wrapped `---BEGIN <name>--- … ---END <name>---`.
    6. `### Bill view model (data model of surface "bill")`: the JSON Schema of `BillViewModel` plus one sample projection of the control example (built via `buildControlExample` from `server/src/domain/fixtures/control-example.ts` into a throwaway `BillStore`, then `projectBill`) so the model sees concrete paths and Russian labels; state that the server owns this data and the model must bind to these paths only.
    7. `### UI actions the server understands`: the Action contract table (names + exact context shapes); unknown names are forwarded to the model as `[UI action] …` messages; the layout must include at least: people list with rename/remove, draft inputs with `add_person`/`add_item`, items list with `select_item`/`remove_item`, the editor card (title/price fields, split-type buttons, payer buttons, the three row lists, `remainingText`, `error`, `save_item`), the summary card (rows + transfers), the `errors.removePerson` block with `fix_item` buttons.
  - Keep the prompt under ~30k tokens (measure once with `client.messages.countTokens` in a script and log it; if larger, drop example 2 first). Export `PROMPT_VERSION` string for telemetry.
  - Test `prompt.test.ts`: builds without throwing; contains all action names from the table and every catalog component name; identical output on two calls (determinism, required for prompt caching).
  - LOGGING: INFO at startup `[agent.prompt] built {chars, promptVersion}`.
  - Files: `a2ui/server/src/agent/prompt.ts`, `a2ui/server/src/agent/__tests__/prompt.test.ts`.

- [x] Task 10: Claude tools (`betaZodTool`) and the per-session agent runner with telemetry (depends on 8, 9)
  - `server/src/agent/tools.ts`: build tools with `betaZodTool` from `@anthropic-ai/sdk/helpers/beta/zod`, bound to a `Session`:
    - Domain tools mirroring TZ §4 names: `create_bill({title, currency?, people: string[], items: [{title, price: string, paidBy: string, split?: {type:"equal", people?: string[]} | {type:"exact", amounts: Record<name,string>} | {type:"shares", weights: Record<name,number>}}]})`, `add_person({name})`, `rename_person({person, name})`, `remove_person({person})`, `add_item({title, price, paidBy, split?})`, `update_item({item, patch: {title?, price?, paidBy?, split?}})`, `remove_item({item})`, `get_summary({})`. People/items are addressed by **name or id** (resolver with exact then case-insensitive match; ambiguity → error). `billId` is implicit (one bill per session; `create_bill` replaces it). Prices and amounts are decimal strings parsed with `parseMajor`. Each `run` returns compact JSON (`{ok: true, bill: …}` with major-unit strings) or, for `DomainError`, returns `JSON.stringify({ok: false, error: {code, message, details}})` — the runner sends it as a normal tool result; include the text "Ошибка" so the model surfaces it. After every successful mutating domain tool: re-project and emit the `diffViewModel(session.lastVm, vm)` entries as `updateDataModel("bill", value, path)` to the session's SSE sink **only if** the `bill` surface has been rendered already (`session.surfaces.has("bill")`), then set `session.lastVm = vm`. Domain tools invoked by the model also set `session.modelSeenVersion = store.version` (the model saw the result).
    - `render_surface({surfaceId: string, components: Array<Record<string, unknown>>, data?: Record<string, unknown>})` (describe `components` as "A2UI v0.9 components, flat array, root first"): run `validateComponents`; on failure return `is_error`-style result `{ok:false, error:{code:"A2UI_INVALID", errors}}` (the runner feeds it back; cap repairs at 3 per turn then give up with a chat message); on success emit `[deleteSurface(id) if exists] createSurface(id, {sendDataModel: true}) , updateComponents(id, components), updateDataModel(id, surfaceId === "bill" ? projectBill(...) : data ?? {}, "/")` (for `bill` also set `session.lastVm` to that projection — a fresh surface always gets the full model), record `session.surfaces.add(id)`, return `{ok:true, rendered: components.length}`. Set `eager_input_streaming: true` on this tool (spread onto the `betaZodTool` result) — consumed by task 12.
  - `server/src/agent/runner.ts`: `runTurn(session, userContent: string | ContentBlockParam[], sink)`: **state sync first** — UI actions (task 8) mutate the bill without the model, so its history goes stale; if a bill exists and `store.version > session.modelSeenVersion`, prepend a text block `[Состояние счёта изменено через интерфейс]\n<compact summary: people; items with price, payer, splitText; balances; transfers>` to the user content and set `session.modelSeenVersion = store.version`. Never edit the system prompt or earlier messages for this (append-only keeps the prompt cache and `claude-opus-5-5` preserved thinking valid). Then push `{role:"user", content}` to `session.messages`; `const runner = client.beta.messages.toolRunner({ model: env.ANTHROPIC_MODEL ?? "claude-opus-5-5", max_tokens: 32000, system: [{type:"text", text: SYSTEM_PROMPT, cache_control: {type:"ephemeral"}}], tools, messages: session.messages, stream: true, output_config: {effort: env.ANTHROPIC_EFFORT ?? "medium"} })` (thinking is adaptive by default on `claude-opus-5-5`; do not pass `thinking`/`budget_tokens`; do not force `tool_choice`). Iterate `for await (const stream of runner)`: forward `text_delta` events to the sink as `chat` events; on `input_json_delta` for `render_surface` hand `partial_json` to the stream extractor (task 12); after `await stream.finalMessage()` accumulate `usage` (input, output, cache read/create) and apply the stop-reason rules from the claude-api skill: `max_tokens` with a `tool_use` block → abort the turn with an error event; `refusal` → stop; wrap the loop to re-issue once on a JSON parse rejection (`runner.params`) and rethrow `Anthropic.APIError`. After the loop persist `session.messages = runner.params.messages` and append the final assistant message if the runner did not already (verify once by logging the last role). Catch `Anthropic.AuthenticationError`, `RateLimitError`, `APIError` separately and surface a readable `error` SSE event.
  - `server/src/agent/telemetry.ts`: per turn `{turn, startedAt, firstA2uiMs, firstTextMs, totalMs, tokens: {input, output, cacheRead, cacheWrite}, iterations, messageCounts: {createSurface, updateComponents, updateDataModel, deleteSurface}, validationRepairs, promptVersion, model}`; pushed to `session.telemetry` and emitted as a `status` SSE event at turn end. This is the raw data for TZ §7 "Скорость и токены", "Обновление на месте", "Надёжность".
  - Test `tools.test.ts` (no network): tool `run` functions against a session — `create_bill` with the control example in major units then `get_summary` matches §6; `render_surface` with an invalid tree returns the error JSON and emits nothing; with a valid tree emits `createSurface`+`updateComponents`+`updateDataModel`; a second render of `bill` emits `deleteSurface` first; `update_item` after render emits only `updateDataModel` envelopes (diffed paths, no `/`). `runner.test.ts` (Anthropic client stubbed — no network): after a UI action bumps `store.version`, the next `runTurn` sends a first user block starting with `[Состояние счёта изменено через интерфейс]` and earlier `session.messages` entries are byte-identical to before; with no UI change, no state block is added.
  - LOGGING: INFO `[agent.turn.start] {session, turn, model, stateSynced: boolean, storeVersion}`, DEBUG every tool call `{name, input}` and result size, DEBUG each emitted envelope type + byte size, INFO `[agent.turn.end]` with the telemetry object, WARN on validation repair, ERROR on API errors with status.
  - Files: `a2ui/server/src/agent/{tools,runner,telemetry}.ts`, `a2ui/server/src/agent/__tests__/{tools,runner}.test.ts`.

- [x] Task 11: HTTP server — sessions, SSE hub and the API routes (depends on 10)
  - `server/src/http/sse.ts`: `SseHub` keyed by sessionId; `send(sessionId, event: "a2ui" | "chat" | "status" | "error", data)` writes `event: <name>\ndata: <json>\n\n`; heartbeat comment every 15 s; on connect replay the session's `envelopeLog` (all A2UI envelopes emitted so far, so a page reload rebuilds the surfaces — the client dedupes `createSurface`).
  - `server/src/http/server.ts` (express 5, `express.json({limit: "15mb"})` for S9 images): `GET /api/events?sessionId=` (SSE headers, `X-Accel-Buffering: no`), `POST /api/chat {sessionId, text}` → 202 and `runTurn` in the background (one turn at a time per session; a second request while busy → 409), `POST /api/action {sessionId, version, action, a2uiClientDataModel?}` → `dispatchAction`; `handled` → emit envelopes, respond `{handled: true}`; `forward` → start a turn with the forwarded message, respond `{handled: false, forwarded: true}`, `POST /api/upload {sessionId, mediaType, dataBase64, text?}` → `runTurn` with `[{type:"image", source:{type:"base64", media_type, data}}, {type:"text", text: text ?? "Распознай позиции чека и создай счёт; спроси, кто платил, если не ясно"}]`, `GET /api/log?sessionId=` → `{telemetry, envelopeCounts}`, `GET /api/debug/bill?sessionId=` → raw bill + summary (demo/verification aid), `GET /api/health`.
  - Request validation with Zod; errors → `{error: {code, message}}` with 400/404/409/500; never leak the API key.
  - Manual verification: `curl -N localhost:8787/api/events?sessionId=t1` in one terminal, `curl -X POST localhost:8787/api/chat -d '{"sessionId":"t1","text":"Были Аня, Боря, Вика, Гена. Еда 1200 платил Боря поровну…"}'` in another → `a2ui` events arrive (requires credentials: `ant auth status` shows an active profile, or `ANTHROPIC_API_KEY` is set).
  - LOGGING: INFO per request `[http] METHOD path {sessionId, status, ms}`; DEBUG SSE connect/disconnect and replay size; ERROR with stack for 500s.
  - Files: `a2ui/server/src/http/{server,sse,sessions}.ts`.

- [x] Task 12: Streaming surface rendering (S10) via `eager_input_streaming` (depends on 10)
  - `server/src/a2ui/stream-extract.ts`: `class ComponentStreamExtractor` fed with `partial_json` chunks of the `render_surface` tool input; a small brace/bracket/string-aware scanner that (a) captures `"surfaceId"` as soon as its string closes, (b) once inside the `"components"` array, emits each top-level object as soon as its closing brace arrives, (c) exposes `done()` with the full parsed input. Emits `onSurfaceId(id)` → the runner sends `[deleteSurface?] createSurface` immediately; `onComponents(batch)` flushed every 150 ms or 8 components → `updateComponents(id, batch)` (the renderer shows "[Loading root…]" until `root` arrives, hence the prompt rule "root first"; dangling child ids are tolerated by the processor when `validationConfig` is not set, which the client never sets). When the tool finishes, run `validateComponents` on the complete array: if invalid → emit `deleteSurface(id)` and return the validation error to the model (as in task 10); if valid → emit `updateDataModel`. If `A2UI_STREAM=0`, skip incremental emission and behave as task 10.
  - Guard: the system prompt says to write `surfaceId` before `components` in the tool input (task 9, workflow section); if `components` arrive before `surfaceId`, buffer until it is known.
  - Tests `stream-extract.test.ts`: feed a valid tool input split at awkward points (inside strings with braces/escaped quotes, between array items, mid-key) → components emitted in order, counts equal, `done()` deep-equals the parsed input; invalid JSON tail → `done()` throws a readable error.
  - Telemetry: `firstA2uiMs` measured at the `createSurface` emission for streamed turns (TZ §7 "Время до отрисовки").
  - LOGGING: DEBUG `[a2ui.stream] surfaceId`, `[a2ui.stream] flush {n, totalSoFar}`, WARN on final validation failure after streaming (surface deleted).
  - Files: `a2ui/server/src/a2ui/stream-extract.ts`, `a2ui/server/src/a2ui/__tests__/stream-extract.test.ts`, changes in `a2ui/server/src/agent/runner.ts`.
<!-- Commit checkpoint: tasks 8-12 -->

### Phase 5: Client integration and scenario tooling

- [x] Task 13: Web app — SSE → processor, actions → server, chat pane, upload, message log (depends on 2, 11)
  - `web/src/a2ui/api.ts`: `sessionId` from `sessionStorage` (uuid v4 via `crypto.randomUUID()`); `EventSource('/api/events?sessionId=…')` with handlers per event name; `postChat(text)`, `postAction(action, dataModel)`, `postUpload(file)` (read as base64; `image/jpeg|png`), `getLog()`.
  - `processor.ts` action handler: `postAction({version:"v0.9", action}, processor.getRendererDataModel("v0.9"))` — the data model is attached by us (nothing in `@a2ui/react` or the sample shell does it); on `{forwarded: true}` show a "Агент думает…" indicator.
  - `App.tsx` layout: left column chat (`Chat.tsx`: message list with streamed assistant text, input, Send, "Фото чека" file button, quick buttons with the TZ scenario texts: S1 control-example text, S6 "Гена тоже курил, одна доля", S7 "Покажи диаграммой, кто сколько потратил"); right column `Surfaces` (all surfaces, `bill` first); bottom drawer `MessageLog.tsx`: table of turns from `status` events (tokens, first A2UI ms, total ms, counts of createSurface/updateComponents/updateDataModel/deleteSurface, repairs) plus a raw envelope list with type badges and a copy-JSON button — this is the on-screen evidence for S6 ("patch or full redraw") and S10.
  - Error handling: `feed()` rejections appear as a red banner with the offending envelope (helps the "Надёжность" count); `error` SSE events shown in chat.
  - Reload resilience: on SSE connect the server replays envelopes; the processor dedupes `createSurface`.
  - LOGGING (browser console, prefixed): `[api]` requests with ms, `[a2ui.processor] feed`, `[a2ui.action]`, `[sse] open/close/error`.
  - Files: `a2ui/web/src/a2ui/{api,processor}.ts`, `a2ui/web/src/components/{Chat,MessageLog,Surfaces}.tsx`, `a2ui/web/src/App.tsx`, `a2ui/web/src/a2ui.css`.

- [x] Task 14: Scenario scripts — S1 smoke/bench against the live model and the manual demo checklist (depends on 11, 12, 13)
  - `server/scripts/smoke-s1.ts` (`npm -w server run smoke:s1`, needs Anthropic credentials — an `ant auth login` profile or `ANTHROPIC_API_KEY`): creates a session, runs the S1 control-example text through `runTurn` with an in-memory sink, then asserts: a `bill` surface was rendered, `validateComponents` passed first time or after ≤3 repairs, `GET /api/debug/bill` summary equals §6 (balances +385/+385/−405/−365, 3 transfers); then runs the S6 text and asserts the turn emitted `updateDataModel ≥ 1` and `updateComponents == 0`, balances +465/+425/−365/−525. Prints a pass/fail table.
  - `server/scripts/bench-s1.ts` (`npm -w server run bench:s1 -- --runs 10`): repeats S1 in fresh sessions, records per run: valid first try (y/n), repairs, components count, output tokens, input tokens (cache read vs write), first-A2UI ms, total ms; writes `a2ui/bench/s1-<timestamp>.json` and prints mean/median — the numbers for TZ §7 "Надёжность" and "Скорость и токены". Run the S5 summary screen variant with `--scenario s5` (user asks "покажи итог") for the S5 measurement.
  - Manual demo checklist `a2ui/docs/DEMO.md`: step-by-step S1–S9 using the control example with expected on-screen values, which panel proves which §7 criterion, and the fixture for S9 (`photo_2026-10-04_18-36-09.jpg`, METRO receipt, SUMA 723.67).
  - LOGGING: scripts log at INFO with the same logger; `LOG_LEVEL=warn` by default inside bench to keep the output readable.
  - Files: `a2ui/server/scripts/{smoke-s1,bench-s1}.ts`, `a2ui/server/package.json` (scripts), `a2ui/docs/DEMO.md`, `a2ui/.gitignore` (`bench/`).

### Phase 6: Deliverables (TZ §8)

- [x] Task 15: README and REPORT skeleton (depends on 13, 14)
  - `a2ui/README.md`: what this is (participant #2, A2UI v0.9, Claude via thin TS stack), prerequisites (Node ≥ 22; Anthropic credentials via `brew install anthropics/tap/ant && ant auth login` — or `ANTHROPIC_API_KEY` as the alternative; check with `ant auth status`), one-command run (`cp .env.example .env && npm install && npm run dev`, open the Vite URL), architecture diagram from this plan, how the three message types map to S1/S6, how UI actions bypass the model, env knobs (`ANTHROPIC_MODEL`, `ANTHROPIC_EFFORT`, `A2UI_STREAM`, `LOG_LEVEL`), test/bench commands, link to `docs/DEMO.md`.
  - `a2ui/REPORT.md` (TZ §8.3 structure, Russian headings as in TZ): the §7 criteria table with empty score cells and the already-known facts pre-filled in the "обоснование" column (model-authored tree from the catalog; no model round trip for S2–S5; S6 = `updateDataModel` only; no visibility/arith/chart in the catalog; published React renderer CSS-module gap; TS agent SDK is a placeholder; relative-path action context works; nested templates untested), the "Spike log" from task 2, sections "Понравилось / Мешало", "Лог затыков" (seeded with the planning-time findings), and "Вердикт" (empty). Bench numbers are pasted from `bench/` by the human on hackathon day.
  - Docs policy is `yes`: `/aif-implement` must run its documentation checkpoint (`/aif-docs`) at completion; this task provides the content.
  - LOGGING: n/a (documentation).
  - Files: `a2ui/README.md`, `a2ui/REPORT.md`.
<!-- Commit checkpoint: tasks 13-15 -->

## Risks and decisions log
- Published `@a2ui/react@0.12.0` renders Button/Text/TextField/ChoicePicker without class names (empty CSS-module maps in the tarball). Mitigation: own element-scoped CSS (task 2); fallback: alias to vendored renderer source.
- Nested templates have no upstream tests → the production view model avoids them (master–detail `/editor`); the spike records actual behavior for the report.
- `@a2ui/agent` (TS) is a placeholder → prompt/validation/streaming are our code (tasks 6, 9, 12), ported from the Python SDK's `direct_json` format.
- The system prompt embeds the catalog schema (large). Prompt caching via `cache_control` on the system block and a deterministic prompt keep input cost flat; measure once and trim examples if needed.
- `claude-opus-5-5` rejects forced `tool_choice` and `thinking: disabled`; the runner uses `auto` + prompt steering and adaptive thinking with `effort` from env. If the team settles on another model, only `ANTHROPIC_MODEL`/`ANTHROPIC_EFFORT` change.
- Money units interpretation (major-unit I/O, minor storage) is recorded in Requirements Reconciliation; flag it to the other participants before the demo so all four demos agree.

<!-- aif-verify 2026-10-04: status warn, accepted as-is.
Accepted: live-model checks not run (Task 9 countTokens, Task 11 curl round trip, Task 14 smoke/bench; need `ant auth login`);
scope additions errors.general + debug-only /api/debug/seed (A2UI_DEBUG=1); primary Button variant not styleable in @a2ui/react 0.12.0;
no ARCHITECTURE/RULES/ROADMAP artifacts (context-gate WARNs). -->
