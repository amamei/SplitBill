# Implementation Plan: "New bill" button — clear all data and start over

Branch: feature/a2ui-clear-bill
Created: 2026-10-04

## Original Request
Add clear button that will clear all data to start new bill

## Settings
- Testing: yes
- Logging: verbose
- Docs: yes  # mandatory docs checkpoint in /aif-implement (README / docs/DEMO.md mention of the button)

## Design Summary

- **Where state lives.** All bill data lives server-side in `Session` (`a2ui/server/src/agent/session.ts`): `store`, `billId`, `ui`, `lastVm`, `modelSeenVersion`, `messages` (LLM history), `telemetry`, `surfaces`, `envelopeLog`, `streamedRenders`, `turnCounter`. `envelopeLog` and `telemetry` are replayed on every SSE connect (`server/src/http/sse.ts`), so a client-only wipe would come back on reload. **The reset must happen on the server.**
- **Approach: in-place reset, same session id.**
  - A new `POST /api/reset` calls `Session.reset()`. The method clears every field above on the existing `Session` object. Do not replace the object: SSE sinks hold a reference to it.
  - In this order, it then:
    1. pushes a `chat` event `{type:"reset"}`;
    2. emits one real A2UI `deleteSurface` envelope per live surface;
    3. truncates `envelopeLog`, so a reload replays nothing.
  - Because of this order, the client clears its local state first, and the `deleteSurface` envelopes then show up in the fresh debug log as evidence.
  - Rejected alternative: rotating `sessionStorage["a2ui-session"]` and running `location.reload()`. It leaks the old session in memory and reloads the whole UI.
- **Client.**
  - The `reset` chat event is handled in `App.tsx`, so every tab on the session resets, not just the one that clicked. The handler:
    - bumps a `resetEpoch` used as `key` on `<Chat>` and `<Surfaces>`, which remounts them and drops `lines`, object URLs, `hidden`, `collapsed` and `currentId`;
    - clears the debug feed;
    - switches the mobile pane back to chat;
    - resets `autoSwitchedToBill`.
  - `deleteSurface` envelopes remove the surfaces through the existing `processor.onSurfaceDeleted` path.
- **UX.**
  - A "Новый счёт" `.header-button` goes first in `.header-actions` (`AppHeader.tsx`). It shows an icon only at ≤420px.
  - It is disabled while `agentBusy`.
  - Clicking opens a confirm dialog: "Начать новый счёт? Участники, позиции и переписка будут удалены." with the buttons "Очистить" (danger) and "Отмена" (focused by default; Escape cancels).
  - After a successful reset: the toast "Начат новый счёт" appears and the composer gets focus.
  - On a 409 BUSY: the toast shows the server message.
- **Preserved.**
  - The localStorage prefs `a2ui-theme`, `a2ui-debug` and `a2ui-debug-open` are kept.
  - The session id is kept.
- **Out of scope.**
  - No keyboard shortcut, because a destructive action should not have a global hotkey.
  - No LLM tool or `ACTION_CONTRACT` entry, so `promptVersion` stays unchanged and the reset is never model-driven.
  - No undo.

## Requirements Reconciliation
Authority: user request + clarification answer ("Confirm, then full reset; keep theme/prefs"). No other source constrains this feature.

| Supported combination | Expected behavior | Verification evidence |
|---|---|---|
| Bill exists, surfaces `bill` (+ e.g. `chart-1`), idle | 200 `{reset:true, deletedSurfaces:2}`. Client receives `chat reset`, then 2× `deleteSurface`. Server state is empty. A reload replays nothing. | Server test (Task 3) + manual check in browser |
| No bill yet (fresh session), idle | 200 `{reset:true, deletedSurfaces:0}`, no envelopes, no error | Server test (Task 3) |
| Agent turn in progress (`session.busy`) | 409 `BUSY`, state untouched. Client button is disabled, and a race shows the error toast. | Server test (Task 3) + manual check |
| Two tabs on the same session | Both tabs clear via the SSE `reset` event | Manual check (Task 6 verification) |
| After reset, a new bill via chat / "Пример из ТЗ" chip | The model starts with empty history, `create_bill` yields a fresh bill, and `render_surface` creates `bill` again (no duplicate-skip) | Server test (Task 3: `messages` empty, `surfaces` empty) + manual run of the TZ §6 control example |

## Commit Plan
- **Commit 1** (after tasks 1-3): `feat(server): in-place session reset and POST /api/reset`
- **Commit 2** (after tasks 4-7): `feat(web): "Новый счёт" button with confirm dialog and client reset`

## Tasks

### Phase 1: Server reset

- [x] Task 1: Add `Session.reset()` in `a2ui/server/src/agent/session.ts`.
  - **Store field.** Make `store` assignable: drop `readonly`, assign `this.store = new BillStore()`.
    - Before doing so, grep the server for code that caches a `session.store` reference across calls (`tools.ts`, `actions.ts`, `runner.ts`). Each call should re-read it.
  - **Method:** `reset(): { deletedSurfaces: string[] }`.
    1. If `this.busy`, throw an `Error("session busy")`. The route maps it to 409, but the route should pre-check `busy` too.
    2. Snapshot `[...this.surfaces]`.
    3. Clear `billId=undefined`, `ui={}`, `lastVm=undefined`, `modelSeenVersion=0`, `messages=[]`, `telemetry=[]` (reassign or `length=0`), `streamedRenders.clear()`, `turnCounter=0`, `recorder=undefined`, and the new store.
    4. `this.send("chat", { type: "reset" })`.
    5. `this.emit(snapshot.map(deleteSurface), undefined)`, importing `deleteSurface` from `../a2ui/envelopes.js`. `emit` also removes the ids from `surfaces`.
    6. `this.envelopeLog.length = 0`, so that SSE replay is empty.
    7. Return the snapshot.
  - Update the file header comment to mention the reset.
  - LOGGING (scope `agent.session`):
    - `info("reset", { session, deletedSurfaces, hadBill, messages: <count before>, envelopes: <log length before> })`;
    - `warn("reset refused: busy", { session })`;
    - `debug` per cleared field group if helpful.
  - Files: `a2ui/server/src/agent/session.ts`.

- [x] Task 2: Add the `POST /api/reset` route in `a2ui/server/src/http/server.ts` (depends on 1).
  - Body `{ sessionId }`: reuse `z.object({ sessionId: SessionId })`, as `/api/debug/seed` does.
  - If `session.busy`, throw `new HttpError(409, "BUSY", "Агент ещё отвечает — дождитесь ответа и попробуйте снова")`.
  - Call `session.reset()` and respond `200 { reset: true, deletedSurfaces: n }`.
  - Use `sessions.get()`, which is get-or-create, so a reset on an unknown id is harmless.
  - Place it next to `/api/action`, before the `/api` 404 fallback.
  - LOGGING:
    - The existing request middleware already logs `POST /api/reset {sessionId,status,ms}`.
    - Add `logger.info("reset", { session, deletedSurfaces: n })` in `http.server`.
    - Busy rejections already surface as the 409 status in the middleware line.
  - Files: `a2ui/server/src/http/server.ts`.

- [x] Task 3: Server tests for reset (depends on 1). New file `a2ui/server/src/agent/__tests__/session.test.ts` (node:test + `node:assert/strict`, using `controlSession()` from `./helpers.ts`). Cases:
  1. **Bill + extra surface.** Take `controlSession()`, add `surfaces.add("chart-1")`, push a fake message and telemetry, and subscribe a capturing sink. After `reset()`:
     - the captured events are exactly `chat {type:"reset"}`, then a `deleteSurface` for `bill` and one for `chart-1`, in that order;
     - `billId`, `lastVm` and `messages` are empty, and so are `telemetry`, `surfaces`, `envelopeLog` and `streamedRenders`;
     - `modelSeenVersion` is 0.
  2. **Fresh session.** `new Session("t")`: `reset()` returns `[]`, emits only the `chat reset` event and does not throw.
  3. **Busy session.** With `busy=true`, `reset()` throws and leaves state untouched (`billId` is still set).
  4. **Fresh state after reset.**
     - `dispatchAction(session, action("add_person", …))` returns `{kind:"handled", envelopes:[]}` (the no-bill guard).
     - Creating a bill via `buildControlExample(session.store)` works on the new store, with `version` starting from 0.
  - Run `npm -w server test` and `npm -w server run typecheck`.
  - LOGGING: tests run with `LOG_LEVEL=error`. There is nothing to add; make sure `reset` logs don't throw with the test sink.
  - Files: `a2ui/server/src/agent/__tests__/session.test.ts`.

<!-- Commit checkpoint: tasks 1-3 -->

### Phase 2: Web client

- [x] Task 4: Client API and processor support for reset (depends on 2).
  - **`a2ui/web/src/a2ui/api.ts`:**
    - Extend `ChatEvent` with `| { type: "reset" }`.
    - In the `chat` SSE listener, on `reset` call `setActivity({ agentBusy: false })`, then `publish` as usual.
    - Add `export function postReset(): Promise<{ reset: boolean; deletedSurfaces: number }>`, which returns `post("/api/reset", { sessionId })`. It must not go through `startTurn`, because it is not an agent turn.
  - **`a2ui/web/src/a2ui/processor.ts`:**
    - In `feed()`, mirror the existing duplicate-`createSurface` skip: skip a `deleteSurface` whose surface is not live (`!processor.getSurface(id)`). This avoids a FeedError or render-error toast if a stale tab already lacks the surface.
    - Log the skip with `debug("processor", "skip deleteSurface: unknown surface", { surfaceId })`.
  - LOGGING:
    - `info("api", "reset requested", { sessionId })`, then `info("api", "reset done", { deletedSurfaces })`.
    - `info("sse", "reset event")`.
    - `warn("api", "reset failed", { message })` on error.
  - Files: `a2ui/web/src/a2ui/api.ts`, `a2ui/web/src/a2ui/processor.ts`.

- [x] Task 5: Client-side reset of the app state (depends on 4).
  - **`a2ui/web/src/lib/debugFeed.ts`:** add `clearAll()` to the `DebugFeed` interface and the hook. It resets `turns`, `entries` and `renderErrors`.
  - **`a2ui/web/src/App.tsx`:**
    - Add `const [resetEpoch, setResetEpoch] = useState(0)`.
    - Add a `subscribe` effect. On `kind:"chat" && event.type === "reset"`, it:
      - runs `setResetEpoch(n => n + 1)`;
      - runs `feed.clearAll()`;
      - sets the module-level `autoSwitchedToBill = false`;
      - runs `setUnseen(0)` (or the existing equivalent);
      - runs `showPane("chat")`.
    - Pass `key={resetEpoch}` to `<Chat>` (remount clears `lines`, revokes object URLs via unmount cleanup and shows `chat-welcome`) and to `<Surfaces>` (clears `hidden`, `collapsed`, `freshIds` and `currentId`).
    - Apply this in both the desktop and mobile layouts. Spike mode is unaffected.
  - **Handler:** add `async function handleNewBillConfirmed()`. It:
    1. calls `await postReset()`;
    2. on success shows the toast "Начат новый счёт" and focuses `composerRef`;
    3. on error shows a toast with the error message.
    - The visible reset itself is driven by the SSE event, not by the POST response, so other tabs behave the same.
  - LOGGING:
    - `info("app", "reset applied", { epoch })`.
    - `debug("app", "new bill confirmed")` and `debug("app", "new bill cancelled")`.
  - Files: `a2ui/web/src/lib/debugFeed.ts`, `a2ui/web/src/App.tsx`.

- [x] Task 6: "Новый счёт" button and confirm dialog (depends on 5).
  - **New `a2ui/web/src/components/ConfirmDialog.tsx`.**
    - Props: `{ open, title, text, confirmLabel, cancelLabel, danger?, onConfirm, onCancel }`.
    - Markup: `role="alertdialog" aria-modal="true" aria-labelledby/aria-describedby`, with a backdrop. Clicking the backdrop cancels.
    - Behavior:
      - focuses the Cancel button on open;
      - traps Tab between the two buttons;
      - returns focus to the trigger on close;
      - disables the confirm button while the POST is pending, to prevent a double submit.
  - **`AppHeader.tsx`:**
    - Add the props `onNewBill` and `newBillDisabled`.
    - Render `<button type="button" className="header-button header-button--danger-hover" onClick={onNewBill} disabled={newBillDisabled} title="Новый счёт — очистить всё">` as the first child of `.header-actions`.
    - The button holds an inline SVG icon and `<span className="header-button-label">Новый счёт</span>`.
  - **`App.tsx`:**
    - Add `confirmOpen` state.
    - The header's `onNewBill` opens the dialog.
    - `newBillDisabled={agentBusy}`, via `useActivity()`.
    - `onConfirm` calls `handleNewBillConfirmed`, then closes the dialog.
    - Put the dialog in `overlays`.
    - Extend the `closeOverlays` (Escape) branch so it closes the confirm dialog first.
  - **Styles (`a2ui/web/src/styles/shell.css`):**
    - Add `.confirm-backdrop` and `.confirm-dialog`, using the existing tokens (`--panel`, `--line`, `--danger`, `--danger-soft`, radius and spacing tokens). They must work in both light and dark themes.
    - Add the danger confirm button style and the hover state for `.header-button--danger-hover`.
    - At `max-width: 420px`, hide `.header-button-label` visually (reuse the `.visually-hidden` pattern) so only the icon remains.
  - **Manual verification:**
    1. Run `npm run dev` and run the TZ §6 example via the "Пример из ТЗ" chip, adding a chart via the "Диаграмма долгов" chip.
    2. Click "Новый счёт", then "Отмена": nothing changes.
    3. Click it again, then "Очистить":
       - the chat shows the welcome state;
       - the bill pane shows the empty state;
       - the debug drawer shows only 2 `deleteSurface` entries.
    4. Reload: still empty.
    5. Run the example again: the bill renders.
    6. Open a second tab with the same session (duplicating the tab copies sessionStorage) and reset from one tab: both clear.
    7. While the agent is answering, the button is disabled.
    8. At mobile width (≤420px) only the icon shows; after the reset, the active tab is Чат.
  - LOGGING:
    - `debug("app", "confirm dialog open")` and `debug("app", "confirm dialog close", { confirmed })`.
  - Files: `a2ui/web/src/components/ConfirmDialog.tsx`, `a2ui/web/src/components/AppHeader.tsx`, `a2ui/web/src/App.tsx`, `a2ui/web/src/styles/shell.css`.

- [x] Task 7: Web tests (depends on 4). Add `a2ui/web/src/a2ui/__tests__/processor.test.ts`, or extend `catalog.test.ts` if processor setup already lives there. Use node:test with `node:assert/strict`. Cases:
  1. `feed([deleteSurface("nope")])` returns `[]`, does not throw, and leaves no surfaces.
  2. `feed([createSurface("bill"), deleteSurface("bill")])` leaves `processor.getSurface("bill")` undefined and returns no errors.
  3. A second `deleteSurface("bill")` after that is skipped without error.
  - Delete any created surfaces in an `afterEach` to keep the singleton clean.
  - If importing `processor.ts` under node fails because of DOM-only deps, extract the skip decision into a pure helper `shouldSkipEnvelope(envelope, isLive)` in `processor.ts` (or `src/lib/`) and test that instead.
  - Run `npm -w web test`, `npm -w web run typecheck`, and finally `npm test && npm run typecheck` at `a2ui/`.
  - LOGGING: none added; tests must pass with debug logging off.
  - Files: `a2ui/web/src/a2ui/__tests__/processor.test.ts` (or `catalog.test.ts`), possibly `a2ui/web/src/a2ui/processor.ts`.

<!-- Commit checkpoint: tasks 4-7 -->
