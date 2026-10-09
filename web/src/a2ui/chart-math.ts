// Pure geometry for the BarChart / PieChart components (no React, no DOM).

export interface ChartItem {
  label: string;
  value: number;
  displayText: string;
  color?: string;
}

const SERIES_SLOTS = 8;

/** Fixed categorical slot by position; past the 8th the series folds into a neutral colour. */
export function seriesColor(index: number, override?: string): string {
  if (override && /^#[0-9a-f]{6}$/i.test(override)) return override;
  return index >= 0 && index < SERIES_SLOTS ? `var(--chart-${index + 1})` : "var(--chart-other)";
}

/** Keeps only well-formed items; a bound path may resolve to anything before data arrives. */
export function toChartItems(raw: unknown): ChartItem[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((it): ChartItem[] => {
    if (typeof it !== "object" || it === null) return [];
    const { label, value, displayText, color } = it as Record<string, unknown>;
    if (typeof value !== "number" || !Number.isFinite(value)) return [];
    return [
      {
        label: typeof label === "string" ? label : String(label ?? ""),
        value: Math.max(0, value),
        displayText: typeof displayText === "string" ? displayText : String(value),
        ...(typeof color === "string" ? { color } : {}),
      },
    ];
  });
}

/** Bar length in percent of the track, relative to the largest value; 0 when all are 0. */
export function barPercent(value: number, items: readonly ChartItem[]): number {
  const max = items.reduce((m, i) => Math.max(m, i.value), 0);
  if (max <= 0) return 0;
  return Math.min(100, Math.max(0, (value / max) * 100));
}

export interface PieSlice {
  item: ChartItem;
  index: number;
  start: number;
  end: number;
  share: number;
}

/** Clockwise slices from 12 o'clock in degrees; zero-value items get no slice. */
export function pieSlices(items: readonly ChartItem[]): PieSlice[] {
  const total = items.reduce((s, i) => s + i.value, 0);
  if (total <= 0) return [];
  let angle = 0;
  const slices: PieSlice[] = [];
  items.forEach((item, index) => {
    if (item.value <= 0) return;
    const sweep = (item.value / total) * 360;
    slices.push({ item, index, start: angle, end: angle + sweep, share: item.value / total });
    angle += sweep;
  });
  return slices;
}

function point(c: number, r: number, deg: number): string {
  const rad = ((deg - 90) * Math.PI) / 180;
  return `${round(c + r * Math.cos(rad))} ${round(c + r * Math.sin(rad))}`;
}

const round = (n: number) => Math.round(n * 100) / 100;

/** SVG path for a pie wedge (inner = 0) or donut segment centred at (c, c). */
export function wedgePath(c: number, outer: number, inner: number, start: number, end: number): string {
  const sweep = end - start;
  if (sweep <= 0) return "";
  if (sweep >= 359.99) {
    // An SVG arc cannot close a full circle on itself: draw two half arcs.
    const ring = (r: number, dir: 0 | 1) =>
      `M ${round(c - r)} ${c} A ${r} ${r} 0 1 ${dir} ${round(c + r)} ${c} A ${r} ${r} 0 1 ${dir} ${round(c - r)} ${c} Z`;
    return inner > 0 ? `${ring(outer, 1)} ${ring(inner, 0)}` : ring(outer, 1);
  }
  const large = sweep > 180 ? 1 : 0;
  if (inner <= 0) {
    return `M ${c} ${c} L ${point(c, outer, start)} A ${outer} ${outer} 0 ${large} 1 ${point(c, outer, end)} Z`;
  }
  return [
    `M ${point(c, outer, start)}`,
    `A ${outer} ${outer} 0 ${large} 1 ${point(c, outer, end)}`,
    `L ${point(c, inner, end)}`,
    `A ${inner} ${inner} 0 ${large} 0 ${point(c, inner, start)}`,
    "Z",
  ].join(" ");
}
