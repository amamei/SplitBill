# Demo checklist (7 minutes, TZ §8.2)

Setup before the demo:

1. `ant auth status` shows an active profile (or `ANTHROPIC_API_KEY` is set in `a2ui/.env`).
2. `cd a2ui && npm run dev`, open the URL the web process prints (`http://localhost:8787` when the path contains `#`, otherwise the Vite URL).
3. Open the page once with `?debug=1` so the **Отладка** button appears in the header (remembered per browser). Keep the drawer **closed** during the demo — it collects turns and envelopes anyway — and open it (button or Ctrl/⌘+Shift+D, Esc closes) only when showing the TZ §7 evidence: per-turn latency/tokens and the raw A2UI stream.
4. Fresh session: open the page in a new tab (the session id lives in `sessionStorage`), or click **Новый счёт** in the header between runs — after the confirm it wipes the bill, the model history and the message log on the server, and every tab of the session returns to the empty screen (the debug log keeps only the resulting `deleteSurface` envelopes).
5. Navigation during the demo: on desktop use the sticky outline above the bill («Участники · Позиции · Редактор позиции · Итог») to jump between sections and the surface chips («Счёт», «Диаграмма 1») to switch surfaces. On a phone-sized window the bottom tabs switch «Чат / Счёт»; a dot marks the tab with updates. Screenshots: `docs/screenshots/`.

Money is entered in lei (major units); the server stores integer bani. All values below are what the UI must show.

## S1 — bill from text

Click **Пример из ТЗ** in the chat (or paste the text):

> Были Аня, Боря, Вика, Гена. Еда 1200 — платил Боря, поровну на всех. Кальяны 800 — платила Аня, доли: Аня 2, Боря 1, Вика 1. Вино 600 — платила Аня, суммы: Аня 250, Боря 250, Вика 100. Чаевые 260 — платила Вика, поровну на всех.

Expect: the `bill` surface appears progressively (S10 streaming: `createSurface`, then `updateComponents` batches, then one `updateDataModel /`).

| | Должен | Заплатил | Баланс |
|---|---|---|---|
| Аня | 1015.00 | 1400.00 | +385.00 |
| Боря | 815.00 | 1200.00 | +385.00 |
| Вика | 665.00 | 260.00 | −405.00 |
| Гена | 365.00 | 0.00 | −365.00 |

Total 2860.00, three transfers (e.g. Вика → Аня 385.00, Гена → Боря 365.00, Вика → Боря 20.00).
Log: turn row with `create 1`, `components ≥ 1`, first-A2UI ms, output tokens → TZ §7 "Время до отрисовки", "Скорость и токены".

## S2 — participants through the UI

- Type «Дима» in "Новый участник" → **Добавить**: Дима appears with 0.00 / 0.00 / 0.00, no item changes (rule 5).
- Edit Боря → «Борис» → **Переименовать**: item payer and split texts update.
- **Удалить** Гена → error block: «Нельзя удалить участника «Гена»: он участвует в позициях «Еда», «Чаевые»» with an **Исправить** button per item. **Исправить** on Еда opens it in the editor.
- Debug drawer: each click is a `UI: <action>` row with only `dataModel` counts, ~1 ms, 0 tokens → no model round trip (TZ §7 "Интерактивность").

## S3 — items through the UI

- "Позиция" «Десерт», "Цена" «150,50» → **Добавить позицию**: new row 150.50, split equally between everyone, opened in the editor.
- In the editor change the title/price → **Сохранить**.
- **Удалить** on the row removes it; the editor moves to the first item.

## S4 — split type

- **Открыть** Вино → editor shows exact amounts 250.00 / 250.00 / 100.00 / 0.00.
- Set Вика to 90 → **Сохранить** → «Не распределено 10.00» + the tool error text; the typed 90 stays, totals unchanged (§6 edge case).
- Set Вика back to 100 → **Сохранить** → error clears.
- **Поровну / Суммы / Доли** switch the input rows (checkboxes / amounts / weights): only the active list is filled — A2UI v0.9 has no conditional visibility, the data decides what is shown.
- Rounding (§6 edge case): add item «Тест» 100 (it opens with **Поровну** on everyone), leave only Аня, Боря, Вика checked, **Сохранить** → shares 33.34 / 33.33 / 33.33.

## S5 — payers and summary

- In the editor the payer buttons show ● on the current payer; click another → payer, balances and transfers update instantly.
- The summary card shows share, paid, balance per person and «кто → кому → сколько». Jump to it with **Итог** in the outline.
- For the S5 speed/token number ask in chat «Покажи итог» (bench: `npm -w server run bench:s1 -- --runs 5 --scenario s5`).

## S6 — words on top of the existing UI

Reset (new tab + S1), then click **Гена курил — правка** («Гена тоже курил, одна доля»).

| | Должен | Заплатил | Баланс |
|---|---|---|---|
| Аня | 935.00 | 1400.00 | +465.00 |
| Боря | 775.00 | 1200.00 | +425.00 |
| Вика | 625.00 | 260.00 | −365.00 |
| Гена | 525.00 | 0.00 | −525.00 |

Кальяны 320 / 160 / 160 / 160. Log: the S6 turn shows `components 0`, `dataModel ≥ 1` → **patch in place, not a redraw** (TZ §7 "Обновление на месте").

## S7 — unplanned request

Click **Диаграмма долгов** («Покажи диаграммой, кто сколько потратил»). There is no chart component in the basic catalog; expect the model to build a new surface (`chart-1`, …) from Rows/Cards with `weight` bars or a table. The new surface scrolls into view, flashes once and gets a chip in the switcher; «Свернуть» / «Скрыть» are local. Record what it did without code changes (TZ §7 "Незапланированное").

## S8 — action from the UI back to the agent

Click **Напомнить** next to Вика (if the model put it in the layout). The chat shows `[UI action] remind {"personId":"p3"}` and the agent writes a reminder with Вика's amount and recipients, taken from `get_summary`.

## S9 — receipt photo

**Фото чека** → `photo_2026-10-04_18-36-09.jpg` from the repository root (METRO receipt, total SUMA 723.67). The agent reads the items, asks who paid if unclear, creates the bill and renders it.

## S10 — streaming

Visible during S1: the surface skeleton (shimmer placeholders) appears before the model finishes the tool call; the header activity bar and the typing dots run until the turn ends. Compare with `A2UI_STREAM=0` in `.env` (the whole tree arrives at once). The log's "1-й A2UI, мс" column is the time to the first `createSurface`.

## Measurements for REPORT.md

```bash
cd a2ui
npm -w server run smoke:s1                              # S1 + S6 against the live model, PASS/FAIL table
npm -w server run bench:s1 -- --runs 10                 # S1 reliability, tokens, latency → bench/s1-*.json
npm -w server run bench:s1 -- --runs 5 --scenario s5    # S5
npm -w server run count:prompt                          # system prompt size in tokens
```
