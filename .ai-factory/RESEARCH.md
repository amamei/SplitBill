# Research

Updated: 2026-10-04 18:44
Status: active

## Active Summary (input for /aif-plan)
<!-- aif:active-summary:start -->
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
<!-- aif:active-summary:end -->

## Sessions
<!-- aif:sessions:start -->
### 2026-10-04 18:44 — How A2UI v0.9 maps onto the Split Bill TZ
What changed: First exploration. Verified A2UI v0.9 against source (cloned `a2ui-project/a2ui`: spec v0.9.1, basic catalog, React renderer, Python agent SDK, samples) rather than blog posts. Full exploration output saved below without reduction.

Key notes:

#### The core idea: A2UI keeps layout and data in separate messages

A v0.9 surface is built from four server-to-client messages:

```
createSurface     { surfaceId, catalogId, sendDataModel? }
updateComponents  { surfaceId, components: [ {id, component:"Text", text:{path:"/x"}}, ... ] }   <- layout
updateDataModel   { surfaceId, path:"/items/2", value:{...} }                                   <- data
deleteSurface     { surfaceId }
```

The client sends back `action { name, surfaceId, sourceComponentId, context }`. If `sendDataModel: true`, it also attaches the surface's entire data model.

This fits the TZ rule "деньги считает код, не модель" (code computes money, the model doesn't). The model writes the layout. Your code writes the data:

```
                 +-------------------------- server ---------------------------+
 chat text ----> |  LLM ---tool calls---> domain (150 LOC, ints) --> projector  |
                 |   |                                         (Bill -> VM)    |
                 |   | updateComponents (layout, LLM-authored)      |          |
                 |   v                                              v          |
                 |  ======================= JSONL / SSE ======================  |
                 +-----------------------------------------------^-------------+
                                                                 | action{name,context}
   +--------------------- browser (own site) -------------------+-----------+
   | chat pane |  @a2ui/react <A2uiSurface>  ← MessageProcessor (web_core)  |
   |           |  inputs bind locally to data model; no network on typing   |
   +-----------------------------------------------------------------------+
```

This leads to the main design decision.

#### Who writes the component tree?

```
 code-authored ◄──────────────────────────────────────────────► model-authored
 [A] server templates      [C] LLM writes layout once,         [B] LLM rewrites full
     emit A2UI JSON            bound to a fixed view-model         tree on every turn
     (= MCP Apps baseline      shape; code pushes data             (most "generative",
      in different syntax)     (recommended)                        slow and flaky)
```

**Recommended: C.** The LLM generates the bill screen in S1 and new screens in S7. Every CRUD action after that is code-only: `action → domain tool → re-project → updateDataModel`. That gives clear answers for two of the comparison criteria:

- **Интерактивность (interactivity):** no model round trip for S2–S5. The action name is dispatched to the domain tool directly.
- **Обновление на месте (in-place update):** in S6 the model calls `update_item` and the client receives only `updateDataModel`. The layout doesn't change. You can show this by counting message types in the log.

#### The basic catalog is thin, and the TZ hits every gap

Basic catalog components: Text, Image, Icon, Video, AudioPlayer, Row, Column, List, Card, Tabs, Modal, Divider, Button, TextField, CheckBox, ChoicePicker, Slider, DateTimeInput. Its functions cover validation, formatting and `and`/`or`/`not` only.

| Gap (checked in `catalog.json` / spec) | Hits | Workaround in A2UI terms |
|---|---|---|
| **No conditional visibility** (no `visible`/`when`) | S4 fields per split type, S2 error block | **Visibility through data:** a `List` template bound to `/items/i/exactRows` renders nothing when the array is empty. The projector fills only the rows for the active split type. |
| **No arithmetic functions** | S4 "сколько осталось распределить" (how much is left to distribute) | (a) a "Пересчитать" (recalculate) button sends an action and the server returns `remainingText`, or (b) a custom function `remaining(price, amounts)` via `createFunctionImplementation`, about 20 lines. |
| **`ChoicePicker.options` is a static array**, not bindable to `/people` | S5 payer picker | Option 1: whenever people change, resend `updateComponents`, which breaks "layout never changes". Option 2: payer as a `List` of buttons over `/people` with `action{set_payer, {itemId, personId}}`. |
| **Tabs has no bound selected state** | S4 | Use three buttons (Поровну / Суммы / Доли = equal / amounts / shares) sending `set_split_type` instead of Tabs. |
| **Typing never triggers the network** | S3/S4 edits | A "Сохранить" (save) button plus `sendDataModel: true`. The server reads the edited values from the attached model and parses strings into minor units in code. |
| **No chart component** | S7 | This is the honest S7 test. The model can only improvise, for example bars from `Row` + `Card` with `weight` proportional to amount. Adding a `BarChart` to a custom catalog would mean the request was planned for. |
| **No file input** | S9 | The upload has to go in the host shell, outside A2UI. |
| **`formatCurrency` takes a value, but you store minor-unit ints** | everywhere | The projector sends preformatted `priceText`. Display is always derived by code. |

Every custom component or function you add moves the result toward the MCP Apps baseline. Recommendation: allow custom **functions** (`remaining`, maybe `formatMinor`) and **no custom components**, and record each one in REPORT.md under "Кто автор UI" (who authors the UI).

#### View-model sketch (projector output)

```jsonc
{
  "bill":   { "title": "Bermuda", "currency": "MDL" },
  "people": [ { "id": "p1", "name": "Аня" }, ... ],
  "items": [{
    "id": "i2", "title": "Кальяны", "priceText": "800.00", "payerName": "Аня",
    "splitType": "shares",
    "equalRows": [],                                   // empty, so the List renders nothing
    "exactRows": [],
    "sharesRows": [ { "itemId": "i2", "personId": "p1", "name": "Аня", "weight": "2", "shareText": "400.00" }, ... ],
    "remainingText": "", "error": ""
  }],
  "summary": { "rows": [ { "name": "Вика", "owesText": "665", "paidText": "260", "balanceText": "−405" } ],
               "transfers": [ { "text": "Вика → Аня 385" } ] },
  "errors":  { "removePerson": { "message": "", "items": [] } }   // S2: filled on failure
}
```

`itemId` is repeated inside each row on purpose. Nested templates resolve relative paths in the inner scope, so a button in an inner row can't easily reach the parent item's id.

#### Scenario map

| | A2UI mechanism | Model round trip? |
|---|---|---|
| S1 | LLM calls `create_bill`, then emits `createSurface` + `updateComponents`; code sends `updateDataModel` | yes (one) |
| S2 | Person buttons send `action`; a failed delete fills `/errors/removePerson/items`, and each listed item gets a "fix" button | no |
| S3 | TextFields + Save use `sendDataModel` | no |
| S4 | Split-type buttons, data-driven lists, `remaining` function or round trip | no |
| S5 | Payer buttons; the summary card is bound to `/summary` | no |
| S6 | Chat → LLM → `update_item` → **updateDataModel only** | yes, patch only |
| S7 | LLM creates a **new surface** using only the catalog | yes |
| S8 | `action{remind,{personId}}` is forwarded to the LLM as a message, and the reply goes into the chat or a new Text surface | yes |
| S9 | Outside A2UI: upload in the shell, then a multimodal LLM call, then `create_bill` | yes |
| S10 | JSONL messages render incrementally; the Python SDK has a streaming parser that repairs malformed JSON | — |

#### Stack: two realistic paths

| | **Official: Python ADK + `a2ui-agent-sdk` + A2A + `samples/client/react/shell`** | **Thin: Node/TS + your LLM SDK + SSE + `@a2ui/react` + `@a2ui/web_core`** |
|---|---|---|
| Time to first screen | Fastest: fork `restaurant_finder` and the React shell | Slower: you write the system prompt and transport yourself |
| Shared model rule | Defaults to Gemini; other models go through `LITELLM_MODEL` (works, but adds a dependency) | Any model, natively |
| Prompt and schema | `A2uiSchemaManager.generate_system_prompt()`, `validate_components`, streaming fixer | You embed `catalog.json` yourself; the TS agent SDK `@a2ui/agent` is **0.0.1** |
| Transport | A2A plus ADK learning curve | About 40 lines of SSE plus a POST for actions |

If the team picks Gemini, take the official path. If it picks Claude or GPT, it's closer: try ADK with LiteLLM first, and fall back to the thin path if that isn't working by the 1:30 cutoff.

#### Risks to settle in the 0:30–1:30 slot

1. **Relative paths inside an `event.context` within a `List` template.** The catalog says "Do NOT use paths for static IDs", but inside templates the id has to be a path. Most of the design depends on this, so test it first.
2. **Nested List templates** (items → rows) render correctly in the React renderer.
3. **What `sendDataModel` payload actually arrives** through your transport. The spec describes A2A metadata; on custom SSE/HTTP you carry it yourself.
4. **Size of the generated tree.** With templates the tree size doesn't depend on the number of items, maybe 40–60 components. Measure output tokens and latency for S1, since the TZ asks for both.
5. **Version drift.** The repo is on v0.9.1 with v1.0 as a release candidate (packages at 0.12.0), and the basic catalog on `main` already uses the `v1_0` id. Pin the v0.9 imports (`@a2ui/react/v0_9`) and the matching catalog id, or the model will mix them.

#### Open questions

- **Which shared model?** It determines the stack choice above.
- **Portability as a demo bonus:** render the same JSONL in the Lit and React renderers side by side. It costs little and is the strongest argument for A2UI in the comparison table.
- **How strict to be about custom functions:** is `remaining()` acceptable as "using the tool as intended", or does it count as hand-written UI?
- **Units in the control example (side note, affects all four participants):** "Еда 1200" reads as whole units, but the edge case "100 → 33.34" implies cents. It's worth agreeing team-wide whether 1200 means 1200 or 120000 minor units.

#### Evidence and inference notes

- Verified in source: message types and fields, ChildList forms, local two-way binding, action forms, `sendDataModel`, basic catalog components/functions and their props (`ChoicePicker.options` static array, `Tabs.tabs` without bound selection, `TextField.variant` enum), custom functions/components API, package versions.
- Inference (not yet tested): the "visibility through data" trick, Row/Card `weight` bars for S7, tree size estimate of 40–60 components, the behavior of relative paths in `event.context` inside templates, nested List rendering.

Links (paths):
- `TZ.md`
- Upstream repo: https://github.com/a2ui-project/a2ui (redirected from https://github.com/google/A2UI)
- Spec: `specification/v0_9_1/docs/a2ui_protocol.md`, `specification/v0_9_1/docs/a2ui_custom_functions.md`, `specification/v0_9_1/catalogs/basic/catalog.json`, `specification/v0_9_1/json/common_types.json`
- React renderer: `renderers/react/README.md`; web core: `typescript/web_core/src/processing/message-processor.ts`
- Python agent SDK: `python/a2ui_agent/README.md`
- Samples: `samples/agent/adk/restaurant_finder/`, `samples/client/react/shell/`, `samples/community/mcp/a2ui-in-mcpapps/`
- Blog: https://developers.googleblog.com/a2ui-v0-9-generative-ui/
- Spec site: https://a2ui.org/specification/v0.9-a2ui/

Coherence gate: first pass FAILED on evidence labeling (untested workarounds stated as settled; the chat-host claim sat under "verified"; the custom-function policy was both decided and open). The Active Summary was qualified without removing content, and the re-check passed.
<!-- aif:sessions:end -->
