import { useEffect, useRef, useState, type RefObject } from "react";
import { postChat, postUpload, subscribe } from "../a2ui/api";

type Line = { id: number; role: "user" | "assistant" | "note" | "error"; text: string; turn?: number };

const QUICK = [
  {
    label: "S1 контрольный пример",
    text: "Были Аня, Боря, Вика, Гена. Еда 1200 — платил Боря, поровну на всех. Кальяны 800 — платила Аня, доли: Аня 2, Боря 1, Вика 1. Вино 600 — платила Аня, суммы: Аня 250, Боря 250, Вика 100. Чаевые 260 — платила Вика, поровну на всех.",
  },
  { label: "S6 Гена курил", text: "Гена тоже курил, одна доля" },
  { label: "S7 диаграмма", text: "Покажи диаграммой, кто сколько потратил" },
];

let nextId = 1;

export function Chat({ composerRef }: { composerRef?: RefObject<HTMLTextAreaElement | null> }) {
  const [lines, setLines] = useState<Line[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(
    () =>
      subscribe((event) => {
        if (event.kind === "chat") {
          const e = event.event;
          if (e.type === "delta") {
            setLines((prev) => {
              const last = prev.at(-1);
              if (last?.role === "assistant" && last.turn === e.turn) {
                return [...prev.slice(0, -1), { ...last, text: last.text + e.text }];
              }
              return [...prev, { id: nextId++, role: "assistant", text: e.text, turn: e.turn }];
            });
          } else if (e.type === "note") {
            setLines((prev) => [...prev, { id: nextId++, role: "note", text: e.text }]);
            setBusy(true);
          } else if (e.type === "done") {
            setBusy(false);
          }
        } else if (event.kind === "error") {
          setLines((prev) => [...prev, { id: nextId++, role: "error", text: event.message }]);
        } else if (event.kind === "forwarded") {
          setBusy(true);
        }
      }),
    [],
  );

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [lines]);

  async function send(value: string) {
    const trimmed = value.trim();
    if (!trimmed || busy) return;
    setLines((prev) => [...prev, { id: nextId++, role: "user", text: trimmed }]);
    setText("");
    setBusy(true);
    try {
      await postChat(trimmed);
    } catch (err) {
      setBusy(false);
      setLines((prev) => [...prev, { id: nextId++, role: "error", text: (err as Error).message }]);
    }
  }

  async function upload(file: File) {
    setLines((prev) => [...prev, { id: nextId++, role: "user", text: `📷 ${file.name}` }]);
    setBusy(true);
    try {
      await postUpload(file);
    } catch (err) {
      setBusy(false);
      setLines((prev) => [...prev, { id: nextId++, role: "error", text: (err as Error).message }]);
    }
  }

  return (
    <div className="chat">
      <div className="chat-lines" ref={listRef}>
        {lines.length === 0 && <p className="chat-hint">Опишите, кто был, что заказали и кто за что платил.</p>}
        {lines.map((l) => (
          <div key={l.id} className={`chat-line chat-${l.role}`}>
            {l.text}
          </div>
        ))}
        {busy && <div className="chat-line chat-note">Агент думает…</div>}
      </div>
      <div className="chat-quick">
        {QUICK.map((q) => (
          <button key={q.label} type="button" disabled={busy} onClick={() => send(q.text)}>
            {q.label}
          </button>
        ))}
      </div>
      <form
        className="chat-form"
        onSubmit={(e) => {
          e.preventDefault();
          void send(text);
        }}
      >
        <textarea
          ref={composerRef}
          value={text}
          rows={3}
          placeholder="Сообщение агенту…"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send(text);
            }
          }}
        />
        <div className="chat-actions">
          <button type="button" disabled={busy} onClick={() => fileRef.current?.click()}>
            Фото чека
          </button>
          <button type="submit" className="primary" disabled={busy || !text.trim()}>
            Отправить
          </button>
        </div>
        <input
          ref={fileRef}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void upload(file);
            e.target.value = "";
          }}
        />
      </form>
    </div>
  );
}
