import { useEffect } from "react";
import { useLocation } from "react-router";

const LAST_NON_CANVAS_PATH_KEY = "mandate.lastNonCanvasPath";

/** Where closing a canvas goes back to: the last page of this tab that was
 *  not a canvas. */
export function getLastNonCanvasPath(): string {
  try {
    const value = window.sessionStorage.getItem(LAST_NON_CANVAS_PATH_KEY);
    if (value?.startsWith("/") && !value.startsWith("/canvas/")) return value;
  } catch {
    // Ignore storage failures and use the stable app fallback below.
  }
  return "/projects";
}

/** Remembers each page that is not a canvas, as the address changes. */
export function useRememberNonCanvasPath(): void {
  const location = useLocation();
  useEffect(() => {
    const pathname = location.pathname || "/";
    if (pathname.startsWith("/canvas/")) return;
    try {
      window.sessionStorage.setItem(LAST_NON_CANVAS_PATH_KEY, `${pathname}${location.search || ""}${location.hash || ""}`);
    } catch {
      // Best-effort UI affordance only.
    }
  }, [location]);
}
