// BarChart / PieChart: this app's own A2UI components. The server validates them against
// server/src/a2ui/custom_components.json; these Zod schemas mirror it so GenericBinder resolves
// "title" and "items" (a literal array or a {"path"} binding) like any basic component prop.
import type { CSSProperties } from "react";
import { z } from "zod";
import { AccessibilityAttributesSchema, DataBindingSchema, DynamicStringSchema } from "@a2ui/web_core/v0_9";
import { createComponentImplementation } from "@a2ui/react/v0_9";
import { barPercent, pieSlices, seriesColor, toChartItems, wedgePath, type ChartItem } from "./chart-math";

const ChartItemSchema = z
  .object({
    label: z.string(),
    value: z.number().min(0),
    displayText: z.string(),
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  })
  .strict();

const common = {
  accessibility: AccessibilityAttributesSchema.describe("REF:#/$defs/AccessibilityAttributes").optional(),
  weight: z.number().optional(),
  title: DynamicStringSchema.describe("REF:#/$defs/DynamicString|Optional caption above the chart.").optional(),
  items: z.union([z.array(ChartItemSchema).min(1), DataBindingSchema]),
};

export const BarChartApi = { name: "BarChart", schema: z.object(common).strict() };
export const PieChartApi = {
  name: "PieChart",
  schema: z.object({ ...common, donut: z.boolean().optional() }).strict(),
};

function frameStyle(weight: unknown): CSSProperties {
  return typeof weight === "number" ? { flex: `${weight}`, minWidth: 0, minHeight: 0 } : {};
}

function ChartTitle({ title }: { title: unknown }) {
  return typeof title === "string" && title.trim() ? <div className="a2ui-chart__title">{title}</div> : null;
}

function describe(items: readonly ChartItem[]): string {
  return items.map((i) => `${i.label}: ${i.displayText}`).join(", ");
}

export const BarChart = createComponentImplementation(BarChartApi, ({ props }) => {
  const items = toChartItems(props.items);
  return (
    <figure className="a2ui-chart a2ui-chart--bar" style={frameStyle(props.weight)}>
      <ChartTitle title={props.title} />
      {items.length === 0 ? (
        <div className="a2ui-chart__empty">Нет данных</div>
      ) : (
        <ul className="a2ui-chart__bars" aria-label={describe(items)}>
          {items.map((item, i) => (
            <li key={`${i}-${item.label}`} className="a2ui-chart__bar-row">
              <span className="a2ui-chart__label">{item.label}</span>
              <span className="a2ui-chart__track" aria-hidden="true" title={`${item.label}: ${item.displayText}`}>
                <span
                  className="a2ui-chart__bar"
                  style={{ width: `${barPercent(item.value, items)}%`, background: seriesColor(i, item.color) }}
                />
              </span>
              <span className="a2ui-chart__value">{item.displayText}</span>
            </li>
          ))}
        </ul>
      )}
    </figure>
  );
});

const PIE_SIZE = 168;

export const PieChart = createComponentImplementation(PieChartApi, ({ props }) => {
  const items = toChartItems(props.items);
  const slices = pieSlices(items);
  const c = PIE_SIZE / 2;
  const outer = c - 2;
  const inner = props.donut === true ? outer * 0.58 : 0;
  return (
    <figure className="a2ui-chart a2ui-chart--pie" style={frameStyle(props.weight)}>
      <ChartTitle title={props.title} />
      {items.length === 0 ? (
        <div className="a2ui-chart__empty">Нет данных</div>
      ) : (
        <div className="a2ui-chart__pie">
          <svg viewBox={`0 0 ${PIE_SIZE} ${PIE_SIZE}`} width={PIE_SIZE} height={PIE_SIZE} role="img" aria-label={describe(items)}>
            {slices.length === 0 ? (
              <path d={wedgePath(c, outer, inner, 0, 360)} fill="var(--chart-track)" fillRule="evenodd" />
            ) : (
              slices.map((s) => (
                <path
                  key={`${s.index}-${s.item.label}`}
                  d={wedgePath(c, outer, inner, s.start, s.end)}
                  fill={seriesColor(s.index, s.item.color)}
                  fillRule="evenodd"
                  stroke="var(--panel)"
                  strokeWidth={slices.length > 1 ? 2 : 0}
                  strokeLinejoin="round"
                >
                  <title>{`${s.item.label}: ${s.item.displayText} (${Math.round(s.share * 100)}%)`}</title>
                </path>
              ))
            )}
          </svg>
          <ul className="a2ui-chart__legend">
            {items.map((item, i) => {
              const share = slices.find((s) => s.index === i)?.share ?? 0;
              return (
                <li key={`${i}-${item.label}`}>
                  <span className="a2ui-chart__swatch" style={{ background: seriesColor(i, item.color) }} aria-hidden="true" />
                  <span className="a2ui-chart__label">{item.label}</span>
                  <span className="a2ui-chart__value">
                    {item.displayText}
                    <span className="a2ui-chart__share"> · {Math.round(share * 100)}%</span>
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </figure>
  );
});
