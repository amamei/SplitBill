// Pure helpers for presenting A2UI surfaces in the shell (ordering, titles, accent, anchors).

export interface SurfaceThemeLike {
  primaryColor?: unknown;
  agentDisplayName?: unknown;
}

/** `bill` first, everything else in creation order (the input order). */
export function orderSurfaces<T extends { id: string }>(surfaces: readonly T[]): T[] {
  return [...surfaces].sort((a, b) => Number(b.id === "bill") - Number(a.id === "bill"));
}

export function surfaceTitle(id: string, theme?: SurfaceThemeLike | null): string {
  if (id === "bill") {
    // The bill's theme name ("Split Bill") is the brand, not a section title.
    return "Счёт";
  }
  const name = theme?.agentDisplayName;
  if (typeof name === "string" && name.trim()) return name.trim();
  const chart = /^chart-(\d+)$/.exec(id);
  if (chart) return `Диаграмма ${chart[1]}`;
  const words = id.replace(/[-_]+/g, " ").trim();
  return words ? words[0]!.toUpperCase() + words.slice(1) : id;
}

/** `primaryColor` from a surface theme, only when it is a plain #RRGGBB value. */
export function safeAccent(theme?: SurfaceThemeLike | null): string | undefined {
  const color = theme?.primaryColor;
  return typeof color === "string" && /^#[0-9a-f]{6}$/i.test(color) ? color : undefined;
}

/** Stable, unique anchor id for a heading text; `used` collects ids already taken. */
export function slugHeading(text: string, used: Set<string>): string {
  const base =
    "sec-" +
    (text
      .toLowerCase()
      .normalize("NFKC")
      .replace(/[^\p{L}\p{N}]+/gu, "-")
      .replace(/^-+|-+$/g, "") || "section");
  let id = base;
  for (let n = 2; used.has(id); n++) id = `${base}-${n}`;
  used.add(id);
  return id;
}
