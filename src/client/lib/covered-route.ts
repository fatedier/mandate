import { createContext, useContext } from "react";
import type { Location } from "react-router";

/** True for the page drawn UNDER a canvas modal: it is still mounted and
 *  still reads its own location, but the history's current entry is the
 *  canvas's, so a step back taken from here would close the canvas instead. */
export const CoveredRouteContext = createContext(false);

/** The history's current location, for what must follow the page actually
 *  shown (where the user is) rather than the page drawn under a canvas. Null
 *  outside the app's routes: there the router's own location is the one. */
export const HistoryLocationContext = createContext<Location | null>(null);

export function useRouteCovered(): boolean {
  return useContext(CoveredRouteContext);
}
