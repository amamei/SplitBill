import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { postChat, postUpload, subscribe } from "../a2ui/api";
import { debug } from "../lib/log";
import { isNearBottom } from "../lib/scroll";
import { useActivity } from "../lib/useServerState";

type Line = { id: number; role: "user" | "assistant" | "note" | "error"; text: string; turn?: number; imageUrl?: string };

// Labels are for people; the texts are the TZ scenarios (S1 control example, S6 edit, S7 chart).
const QUICK = [
  {
    label: "Ужин на четверых — пример",
    text: "Были Аня, Боря, Вика, Гена. Еда 1200 — платил Боря, поровну на всех. Кальяны 800 — платила Аня, доли: Аня 2, Боря 1, Вика 1. Вино 600 — платила Аня, суммы: Аня 250, Боря 250, Вика 100. Чаевые 260 — платила Вика, поровну на всех.",
  },
  { label: "Гена тоже курил", text: "Гена тоже курил, одна доля" },
  { label: "Кто сколько потратил", text: "Покажи диаграммой, кто сколько потратил" },
];

const MAX_ROWS = 6;
let nextId = 1;

export function Chat({ composerRef }: { composerRef?: RefObject<HTMLTextAreaElement | null> }) {
  const [lines, setLines] = useState<Line[]>([]);
  const [text, setText] = useState("");
  const [showNewPill, setShowNewPill] = useState(false);
  const { agentBusy: busy } = useActivity();
  const listRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const ownTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const stickRef = useRef(true);
  const lastUserTextRef = useRef<string | null>(null);
  const objectUrlsRef = useRef<string[]>([]);

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
          }
        } else if (event.kind === "error") {
          setLines((prev) => [...prev, { id: nextId++, role: "error", text: event.message }]);
        }
      }),
    [],
  );

  useEffect(() => () => objectUrlsRef.current.forEach((u) => URL.revokeObjectURL(u)), []);

  // Stick to the bottom only if the reader was already there; otherwise offer a "new messages" pill.
  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el) return;
    if (stickRef.current) {
      el.scrollTop = el.scrollHeight;
      setShowNewPill(false);
    } else if (lines.length > 0) {
      setShowNewPill(true);
    }
  }, [lines, busy]);

  function onListScroll() {
    const el = listRef.current;
    if (!el) return;
    const stick = isNearBottom(el.scrollTop, el.clientHeight, el.scrollHeight);
    if (stick !== stickRef.current) debug("chat", "autoscroll", { stick });
    stickRef.current = stick;
    if (stick) setShowNewPill(false);
  }

  function scrollToBottom() {
    const el = listRef.current;
    if (!el) return;
    stickRef.current = true;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    setShowNewPill(false);
  }

  // Auto-grow the composer from 1 to MAX_ROWS lines.
  useLayoutEffect(() => {
    const ta = ownTextareaRef.current;
    if (!ta) return;
    // border-box: height = content + padding + border; scrollHeight = content + padding.
    const cs = getComputedStyle(ta);
    const padding = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
    const border = parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth);
    const max = (parseFloat(cs.lineHeight) || 20) * MAX_ROWS + padding + border;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight + border, max)}px`;
  }, [text]);

  async function send(value: string) {
    const trimmed = value.trim();
    if (!trimmed || busy) return;
    lastUserTextRef.current = trimmed;
    stickRef.current = true;
    setLines((prev) => [...prev, { id: nextId++, role: "user", text: trimmed }]);
    setText("");
    try {
      await postChat(trimmed);
    } catch (err) {
      setLines((prev) => [...prev, { id: nextId++, role: "error", text: (err as Error).message }]);
    }
  }

  async function upload(file: File) {
    const imageUrl = URL.createObjectURL(file);
    objectUrlsRef.current.push(imageUrl);
    stickRef.current = true;
    setLines((prev) => [...prev, { id: nextId++, role: "user", text: file.name, imageUrl }]);
    try {
      await postUpload(file);
    } catch (err) {
      setLines((prev) => [...prev, { id: nextId++, role: "error", text: (err as Error).message }]);
    }
  }

  const quickChips = (className: string) => (
    <div className={className}>
      {QUICK.map((q) => (
        <button key={q.label} type="button" className="quick-chip" disabled={busy} onClick={() => send(q.text)} title={q.text}>
          {q.label}
        </button>
      ))}
    </div>
  );

  return (
    <div className="chat">
      <div className="chat-lines" ref={listRef} onScroll={onListScroll} role="log" aria-live="polite" aria-relevant="additions" aria-label="Переписка с агентом">
        {lines.length === 0 && (
          <div className="chat-welcome">
            <h2>Разделим счёт</h2>
            <p>Расскажите, кто был, что заказали и кто за что платил. Агент соберёт счёт, а дальше всё правится кнопками.</p>
            {quickChips("chat-welcome-chips")}
            <p className="chat-welcome-keys">
              <kbd>Enter</kbd> — отправить, <kbd>Shift</kbd>+<kbd>Enter</kbd> — новая строка, <kbd>/</kbd> — к полю ввода
            </p>
          </div>
        )}
        {lines.map((l) => (
          <div key={l.id} className={`chat-line chat-${l.role}`}>
            {l.role === "assistant" && <span className="chat-author">Агент</span>}
            {l.imageUrl ? (
              <figure className="chat-photo">
                <img src={l.imageUrl} alt={l.text} />
                <figcaption>{l.text}</figcaption>
              </figure>
            ) : (
              <span className="chat-text">{l.text}</span>
            )}
            {l.role === "error" && lastUserTextRef.current && (
              <button type="button" className="ghost-button" disabled={busy} onClick={() => void send(lastUserTextRef.current ?? "")}>
                Повторить
              </button>
            )}
          </div>
        ))}
        {busy && (
          <div className="chat-line chat-typing" aria-label="Агент печатает">
            <span />
            <span />
            <span />
          </div>
        )}
      </div>
      {showNewPill && (
        <button type="button" className="new-messages-pill" onClick={scrollToBottom}>
          Новые сообщения ↓
        </button>
      )}
      {lines.length > 0 && quickChips("chat-quick")}
      <form
        className="chat-form"
        onSubmit={(e) => {
          e.preventDefault();
          void send(text);
        }}
      >
        <label htmlFor="chat-composer" className="visually-hidden">
          Сообщение агенту
        </label>
        <textarea
          id="chat-composer"
          ref={(el) => {
            ownTextareaRef.current = el;
            if (composerRef) composerRef.current = el;
          }}
          value={text}
          rows={1}
          placeholder="Сообщение агенту…"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void send(text);
            }
          }}
        />
        <div className="chat-actions">
          <button type="button" className="icon-button" disabled={busy} onClick={() => fileRef.current?.click()} title="Фото чека" aria-label="Прикрепить фото чека">
            <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
              <path d="M4 8h3l2-3h6l2 3h3v11H4zM12 10.5a3.5 3.5 0 1 0 0 7a3.5 3.5 0 1 0 0-7" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
            </svg>
          </button>
          <button type="submit" className="send-button" disabled={busy || !text.trim()}>
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
