// A2UI v0.9 server→client envelopes. The model never writes these; it only supplies
// components and data, the server wraps them.
import { createScope } from "../log.js";

const logger = createScope("a2ui.envelopes");

export const A2UI_VERSION = "v0.9" as const;
export const CATALOG_ID = "https://a2ui.org/specification/v0_9/catalogs/basic/catalog.json";

export type A2uiComponent = { id: string; component: string } & Record<string, unknown>;

export type A2uiEnvelope =
  | { version: typeof A2UI_VERSION; createSurface: { surfaceId: string; catalogId: string; sendDataModel?: boolean; theme?: Record<string, unknown> } }
  | { version: typeof A2UI_VERSION; updateComponents: { surfaceId: string; components: A2uiComponent[] } }
  | { version: typeof A2UI_VERSION; updateDataModel: { surfaceId: string; path?: string; value?: unknown } }
  | { version: typeof A2UI_VERSION; deleteSurface: { surfaceId: string } };

/** Spec theme for the bill surface (createSurface.theme: primaryColor #RRGGBB, agentDisplayName). */
export const DEFAULT_THEME = { primaryColor: "#4a3aa8", agentDisplayName: "Split Bill" } as const;

/** The bill carries the full theme; extra surfaces (S7 charts) only the colour, so the client titles them by id. */
export function surfaceTheme(surfaceId: string): Record<string, unknown> {
  return surfaceId === "bill" ? { ...DEFAULT_THEME } : { primaryColor: DEFAULT_THEME.primaryColor };
}

export type A2uiEnvelopeType = "createSurface" | "updateComponents" | "updateDataModel" | "deleteSurface";

export function createSurface(
  surfaceId: string,
  opts: { sendDataModel?: boolean; theme?: Record<string, unknown> } = {},
): A2uiEnvelope {
  const { sendDataModel = true, theme } = opts;
  logger.debug("createSurface", { surfaceId, theme });
  return {
    version: A2UI_VERSION,
    createSurface: { surfaceId, catalogId: CATALOG_ID, sendDataModel, ...(theme ? { theme } : {}) },
  };
}

export function updateComponents(surfaceId: string, components: A2uiComponent[]): A2uiEnvelope {
  return { version: A2UI_VERSION, updateComponents: { surfaceId, components } };
}

export function updateDataModel(surfaceId: string, value: unknown, path = "/"): A2uiEnvelope {
  return { version: A2UI_VERSION, updateDataModel: { surfaceId, path, value } };
}

export function deleteSurface(surfaceId: string): A2uiEnvelope {
  return { version: A2UI_VERSION, deleteSurface: { surfaceId } };
}

export function envelopeType(envelope: A2uiEnvelope): A2uiEnvelopeType {
  return (Object.keys(envelope).find((k) => k !== "version") ?? "updateDataModel") as A2uiEnvelopeType;
}

export function envelopeSurfaceId(envelope: A2uiEnvelope): string {
  const body = (envelope as Record<string, unknown>)[envelopeType(envelope)] as { surfaceId: string };
  return body.surfaceId;
}
