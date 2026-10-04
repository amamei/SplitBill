// React bindings for the connection / activity state kept in a2ui/api.ts.
import { useSyncExternalStore } from "react";
import { getActivity, getConnectionState, subscribe, type Activity, type ConnectionState } from "../a2ui/api";

function subscribeKind(kind: "connection" | "activity") {
  return (onChange: () => void) => subscribe((e) => e.kind === kind && onChange());
}

const subscribeConnection = subscribeKind("connection");
const subscribeActivity = subscribeKind("activity");

export function useConnectionState(): ConnectionState {
  return useSyncExternalStore(subscribeConnection, getConnectionState);
}

export function useActivity(): Activity {
  return useSyncExternalStore(subscribeActivity, getActivity);
}
