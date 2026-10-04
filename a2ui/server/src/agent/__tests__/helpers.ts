import { buildControlExample, type ControlExampleIds } from "../../domain/fixtures/control-example.js";
import { Session } from "../session.js";
import type { ActionPayload } from "../action-types.js";
import type { A2uiEnvelope } from "../../a2ui/envelopes.js";

/** A session with the control example loaded and the bill surface "rendered" (lastVm set). */
export function controlSession(): { session: Session; ids: ControlExampleIds } {
  const session = new Session("test");
  const { billId, ids } = buildControlExample(session.store);
  session.billId = billId;
  session.modelSeenVersion = session.store.version;
  session.surfaces.add("bill");
  session.lastVm = session.project();
  return { session, ids };
}

export function action(name: string, context: Record<string, unknown> = {}): ActionPayload {
  return { name, surfaceId: "bill", sourceComponentId: "btn", timestamp: new Date().toISOString(), context };
}

export function patches(envelopes: A2uiEnvelope[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const e of envelopes) {
    if (!("updateDataModel" in e)) throw new Error(`unexpected envelope ${JSON.stringify(e).slice(0, 80)}`);
    out[e.updateDataModel.path ?? "/"] = e.updateDataModel.value;
  }
  return out;
}
