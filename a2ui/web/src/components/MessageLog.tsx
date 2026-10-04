import { useEffect, useState } from "react";
import { subscribe, type TurnStatus } from "../a2ui/api";
import type { A2uiEnvelope } from "../a2ui/processor";

type Entry = { id: number; envelope: A2uiEnvelope; type: string; bytes: number; rejected: boolean };
const MAX_ENTRIES = 300;
let nextId = 1;

function envelopeType(e: A2uiEnvelope): string {
  return Object.keys(e).find((k) => k !== "version") ?? "?";
}

/** On-screen evidence for TZ §7: per-turn tokens/latency and the raw A2UI message stream. */
export function MessageLog() {
  const [turns, setTurns] = useState<TurnStatus[]>([]);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [open, setOpen] = useState(true);

  useEffect(
    () =>
      subscribe((event) => {
        if (event.kind === "status") {
          setTurns((prev) => [...prev.filter((t) => t.turn !== event.status.turn), event.status].sort((a, b) => a.turn - b.turn));
        } else if (event.kind === "a2ui") {
          const entry = {
            id: nextId++,
            envelope: event.envelope,
            type: envelopeType(event.envelope),
            bytes: JSON.stringify(event.envelope).length,
            rejected: event.errors.length > 0,
          };
          setEntries((prev) => [...prev, entry].slice(-MAX_ENTRIES));
        }
      }),
    [],
  );

  return (
    <section className="log">
      <button type="button" className="log-toggle" onClick={() => setOpen(!open)}>
        {open ? "▾" : "▸"} Лог сообщений A2UI ({entries.length}) и замеры ({turns.length} ходов)
      </button>
      {open && (
        <div className="log-body">
          <table className="log-turns">
            <thead>
              <tr>
                <th>#</th>
                <th>тип</th>
                <th>1-й A2UI, мс</th>
                <th>всего, мс</th>
                <th>out ток.</th>
                <th>in / cache r / w</th>
                <th>create</th>
                <th>components</th>
                <th>dataModel</th>
                <th>delete</th>
                <th>починок</th>
              </tr>
            </thead>
            <tbody>
              {turns.map((t) => (
                <tr key={t.turn} className={t.error ? "log-error" : ""} title={t.error ?? t.model}>
                  <td>{t.turn}</td>
                  <td>{t.kind === "action" && t.action ? `UI: ${t.action}` : t.kind}</td>
                  <td>{t.firstA2uiMs ?? "—"}</td>
                  <td>{t.totalMs}</td>
                  <td>{t.tokens.output}</td>
                  <td>
                    {t.tokens.input} / {t.tokens.cacheRead} / {t.tokens.cacheWrite}
                  </td>
                  <td>{t.messageCounts.createSurface}</td>
                  <td>{t.messageCounts.updateComponents}</td>
                  <td>{t.messageCounts.updateDataModel}</td>
                  <td>{t.messageCounts.deleteSurface}</td>
                  <td>{t.validationRepairs}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <ol className="log-envelopes">
            {[...entries].reverse().map((e) => (
              <li key={e.id} className={e.rejected ? "log-error" : ""}>
                <span className={`badge badge-${e.type}`}>{e.type}</span>
                <code>{summary(e.envelope)}</code>
                <span className="log-bytes">{e.bytes} B</span>
                <button type="button" onClick={() => void navigator.clipboard?.writeText(JSON.stringify(e.envelope, null, 2))}>
                  JSON
                </button>
              </li>
            ))}
          </ol>
        </div>
      )}
    </section>
  );
}

function summary(e: A2uiEnvelope): string {
  const body = e[envelopeType(e)] as { surfaceId?: string; path?: string; components?: unknown[] };
  const parts = [body.surfaceId];
  if (body.components) parts.push(`${body.components.length} компонентов`);
  if (body.path) parts.push(body.path);
  return parts.filter(Boolean).join(" · ");
}
