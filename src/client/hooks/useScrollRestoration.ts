import { useEffect, useRef } from "react";
import { useLocation, useNavigationType } from "react-router";

const STORAGE_PREFIX = "ap.scroll:";

// React Router v7's <ScrollRestoration /> targets the window scroller and
// requires the data-router setup. Our scroll container is the <main> element
// (window doesn't scroll), so we manage restoration ourselves: save the
// container's scrollTop on every navigation, restore on back/forward (POP),
// reset to top on forward navigation to a new path, and leave the scroll
// alone on same-path URL changes (e.g. flipping a filter chip).
export function useScrollRestoration(scrollRef: React.RefObject<HTMLElement | null>) {
  const location = useLocation();
  const navigationType = useNavigationType();
  const previousKeyRef = useRef<string | null>(null);
  const previousPathRef = useRef<string | null>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return undefined;

    const key = STORAGE_PREFIX + location.pathname + location.search;
    const previousKey = previousKeyRef.current;
    const previousPath = previousPathRef.current;

    if (previousKey && previousKey !== key) {
      try { sessionStorage.setItem(previousKey, String(el.scrollTop)); } catch { /* ignore */ }
    }

    if (navigationType === "POP") {
      let restored = 0;
      try { restored = Number(sessionStorage.getItem(key)) || 0; } catch { /* ignore */ }
      el.scrollTop = restored;
    } else if (previousPath !== null && previousPath !== location.pathname) {
      el.scrollTop = 0;
    }

    previousKeyRef.current = key;
    previousPathRef.current = location.pathname;

    return () => {
      try { sessionStorage.setItem(key, String(el.scrollTop)); } catch { /* ignore */ }
    };
  }, [location.pathname, location.search, navigationType, scrollRef]);
}
