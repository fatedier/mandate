import { useCallback, useSyncExternalStore } from "react";

/** Whether a media query matches, kept current. Read as an external store,
 *  so a component that was not listening (hidden in a page kept while
 *  another shows, shell/KeptPage) reads it again when it shows. */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback((onChange: () => void) => {
    if (typeof window === "undefined") return () => {};
    const mql = window.matchMedia(query);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [query]);
  const read = useCallback(() => typeof window !== "undefined" && window.matchMedia(query).matches, [query]);
  return useSyncExternalStore(subscribe, read, () => false);
}
