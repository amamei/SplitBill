import { useCallback, useSyncExternalStore } from "react";

/** Below this width the app switches to one pane at a time with a bottom tab bar. */
export const MOBILE_QUERY = "(max-width: 859.98px)";

export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const mq = matchMedia(query);
      mq.addEventListener("change", onChange);
      return () => mq.removeEventListener("change", onChange);
    },
    [query],
  );
  return useSyncExternalStore(subscribe, () => matchMedia(query).matches);
}
