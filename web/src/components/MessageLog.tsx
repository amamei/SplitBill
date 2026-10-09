// Presentational pieces of the debug drawer: TZ §7 per-turn measurements and the raw A2UI stream.
import type { TurnStatus } from "../a2ui/api";
import type { A2uiEnvelope, FeedError } from "../a2ui/processor";
import { envelopeType, type LogEntry } from "../lib/debugFeed";

export function TurnsTable({ turns }: { turns: TurnStatus[] }) {
  if (turns.length === 0) return <p className="drawer-empty">Ходов ещё не было.</p>;
  return (
    <div className="table-scroll">
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
    </div>
  );
}

export function EnvelopeList({ entries }: { entries: LogEntry[] }) {
  if (entries.length === 0) return <p className="drawer-empty">Сообщений A2UI ещё не было.</p>;
  return (
    <ol className="log-envelopes">
      {[...entries].reverse().map((e) => (
        <li key={e.id} className={e.rejected ? "log-error" : ""}>
          <span className={`badge badge-${e.type}`}>{e.type}</span>
          <code>{summary(e.envelope)}</code>
          <span className="log-bytes">{e.bytes} B</span>
          <button type="button" className="ghost-button" onClick={() => void navigator.clipboard?.writeText(JSON.stringify(e.envelope, null, 2))}>
            JSON
          </button>
        </li>
      ))}
    </ol>
  );
}

export function RenderErrors({ errors, onClear }: { errors: FeedError[]; onClear: () => void }) {
  if (errors.length === 0) return <p className="drawer-empty">Рендерер ничего не отклонял.</p>;
  return (
    <div className="render-errors">
      <button type="button" className="ghost-button" onClick={onClear}>
        Очистить
      </button>
      {errors.map((e, i) => (
        <pre key={i}>
          {e.message}
          {"\n"}
          {JSON.stringify(e.envelope).slice(0, 400)}
        </pre>
      ))}
    </div>
  );
}

function summary(e: A2uiEnvelope): string {
  const body = e[envelopeType(e)] as { surfaceId?: string; path?: string; components?: unknown[] };
  const parts = [body.surfaceId];
  if (body.components) parts.push(`${body.components.length} компонентов`);
  if (body.path) parts.push(body.path);
  return parts.filter(Boolean).join(" · ");
}
