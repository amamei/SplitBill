// The basic catalog with one renderer fix: @a2ui/react@0.12.0 maps Button variants to classes from
// an empty CSS module, so primary / default / borderless buttons render identically. VariantButton
// keeps the basic Button's API, schema and behaviour and only adds `a2ui-btn--<variant>` classes.
// Same catalogId and component set: nothing the agent sees changes.
import { Catalog } from "@a2ui/web_core/v0_9";
import { BASIC_FUNCTIONS, BasicCatalogThemeSchema, ButtonApi } from "@a2ui/web_core/v0_9/basic_catalog";
import { basicCatalog, createComponentImplementation, type ReactComponentImplementation } from "@a2ui/react/v0_9";
import { info } from "../lib/log";

export type ButtonVariant = "default" | "primary" | "borderless";

export function variantClass(variant: unknown): string {
  const v: ButtonVariant = variant === "primary" || variant === "borderless" ? variant : "default";
  return `a2ui-btn a2ui-btn--${v}`;
}

const VariantButton = createComponentImplementation(ButtonApi, ({ props, buildChild }) => (
  <button type="button" className={variantClass(props.variant)} onClick={props.action} disabled={props.isValid === false}>
    {props.child ? buildChild(props.child) : null}
  </button>
));

const components = [...basicCatalog.components.values()].map((c) => (c.name === ButtonApi.name ? VariantButton : c));

export const appCatalog = new Catalog<ReactComponentImplementation>(basicCatalog.id, "0.9", components, BASIC_FUNCTIONS, BasicCatalogThemeSchema);

if (appCatalog.id !== basicCatalog.id || appCatalog.components.size !== basicCatalog.components.size) {
  throw new Error(`appCatalog drifted from basicCatalog (${appCatalog.id}, ${appCatalog.components.size} components)`);
}
info("catalog", "app catalog ready", { id: appCatalog.id, components: appCatalog.components.size });
