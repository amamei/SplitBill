// Client→server action payload (spec client_to_server.json `action`), as the
// @a2ui/web_core ActionPayload delivers it.
export interface ActionPayload {
  name: string;
  surfaceId: string;
  sourceComponentId?: string;
  timestamp?: string;
  context: Record<string, unknown>;
}
