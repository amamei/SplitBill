// A2UI v0.9 server→client envelopes. The model never writes these; it only supplies
// components and data, the server wraps them.

export const A2UI_VERSION = "v0.9" as const;
export const CATALOG_ID = "https://a2ui.org/specification/v0_9/catalogs/basic/catalog.json";

export type A2uiComponent = { id: string; component: string } & Record<string, unknown>;

export type A2uiEnvelope =
  | { version: typeof A2UI_VERSION; createSurface: { surfaceId: string; catalogId: string; sendDataModel?: boolean; theme?: Record<string, unknown> } }
  | { version: typeof A2UI_VERSION; updateComponents: { surfaceId: string; components: A2uiComponent[] } }
  | { version: typeof A2UI_VERSION; updateDataModel: { surfaceId: string; path?: string; value?: unknown } }
  | { version: typeof A2UI_VERSION; deleteSurface: { surfaceId: string } };

export type A2uiEnvelopeType = "createSurface" | "updateComponents" | "updateDataModel" | "deleteSurface";

export function createSurface(
  surfaceId: string,
  opts: { sendDataModel?: boolean; theme?: Record<string, unknown> } = {},
): A2uiEnvelope {
  const { sendDataModel = true, theme } = opts;
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
