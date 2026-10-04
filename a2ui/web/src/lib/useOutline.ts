// Builds an in-surface outline from the headings the agent rendered (Card titles),
// gives each heading an anchor id and tracks which one is currently in view.
import { useEffect, useState } from "react";
import { debug } from "./log";
import { slugHeading } from "./surfaces";

export interface OutlineItem {
  id: string;
  text: string;
}

/** Section titles: the first heading of each Card; without cards, plain h2/h3 headings. */
function sectionHeadings(root: HTMLElement): HTMLElement[] {
  const fromCards = [...root.querySelectorAll<HTMLElement>(".a2ui-card")]
    .map((card) => card.querySelector<HTMLElement>("h2, h3, h4"))
    .filter((h): h is HTMLElement => h !== null);
  const unique = [...new Set(fromCards)];
  return unique.length >= 2 ? unique : [...root.querySelectorAll<HTMLElement>("h2, h3")];
}

function collect(root: HTMLElement): { items: OutlineItem[]; elements: HTMLElement[] } {
  const headings = sectionHeadings(root);
  const used = new Set<string>();
  const items: OutlineItem[] = [];
  const elements: HTMLElement[] = [];
  for (const h of headings) {
    const text = h.textContent?.trim();
    if (!text) continue;
    const id = slugHeading(text, used);
    if (h.id !== id) h.id = id;
    items.push({ id, text });
    elements.push(h);
  }
  return { items, elements };
}

const sameItems = (a: OutlineItem[], b: OutlineItem[]) => a.length === b.length && a.every((x, i) => x.id === b[i]!.id && x.text === b[i]!.text);

export function useOutline(root: HTMLElement | null, surfaceId: string | undefined): { items: OutlineItem[]; activeId: string | undefined } {
  const [items, setItems] = useState<OutlineItem[]>([]);
  const [activeId, setActiveId] = useState<string>();

  useEffect(() => {
    if (!root) {
      setItems([]);
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    let elements: HTMLElement[] = [];
    let visible = new Map<string, boolean>();
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) visible.set(e.target.id, e.isIntersecting);
        const first = elements.find((el) => visible.get(el.id));
        if (first) setActiveId(first.id);
      },
      { rootMargin: "-120px 0px -55% 0px" },
    );

    const refresh = () => {
      const next = collect(root);
      io.disconnect();
      visible = new Map();
      elements = next.elements;
      for (const el of elements) io.observe(el);
      setItems((prev) => {
        if (sameItems(prev, next.items)) return prev;
        debug("nav", "outline", { surfaceId, headings: next.items.map((i) => i.text) });
        return next.items;
      });
    };
    const mo = new MutationObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(refresh, 150);
    });
    mo.observe(root, { childList: true, subtree: true, characterData: true });
    // The last sections may never reach the top band: at the page bottom, highlight the last one.
    const onScroll = () => {
      const atBottom = innerHeight + scrollY >= document.documentElement.scrollHeight - 4;
      if (atBottom && elements.length) setActiveId(elements.at(-1)!.id);
    };
    addEventListener("scroll", onScroll, { passive: true });
    refresh();
    return () => {
      removeEventListener("scroll", onScroll);
      clearTimeout(timer);
      mo.disconnect();
      io.disconnect();
    };
  }, [root, surfaceId]);

  return { items, activeId };
}
