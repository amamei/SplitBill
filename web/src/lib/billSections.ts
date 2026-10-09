// The bill's sections, recognised by the Card titles the layout guide makes the agent use
// («Участники», «Позиции», «Редактор позиции», «Итог»). The client lays the sections out and
// turns the editor into a dialog from these tags, whatever else the generated tree looks like.

export type BillSection = "people" | "items" | "editor" | "summary";

/** Section for a Card title; tolerant of case, extra words and "Позиция" vs "Позиции". */
export function sectionOf(title: string): BillSection | undefined {
  const t = title.trim().toLowerCase();
  if (t.startsWith("редактор")) return "editor";
  if (t.startsWith("участник")) return "people";
  if (t.startsWith("позици")) return "items";
  if (t.startsWith("итог")) return "summary";
  return undefined;
}

/** Top-level Cards of a surface body (a Card nested in a Card is part of its parent). */
function topLevelCards(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(".a2ui-card")].filter((card) => !card.parentElement?.closest(".a2ui-card"));
}

/** Sets `data-section` on each recognised top-level Card and returns the cards by section. */
export function tagSections(root: HTMLElement): Map<BillSection, HTMLElement> {
  const found = new Map<BillSection, HTMLElement>();
  for (const card of topLevelCards(root)) {
    const title = card.querySelector("h2, h3, h4")?.textContent ?? "";
    const section = sectionOf(title);
    if (section && !found.has(section)) {
      found.set(section, card);
      if (card.dataset.section !== section) card.dataset.section = section;
    } else if (card.dataset.section) {
      delete card.dataset.section;
    }
  }
  return found;
}
