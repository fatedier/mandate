import { createContext, useContext } from "react";

/** True for the page drawn UNDER a canvas modal: it is still mounted and
 *  still reads its own location, but the history's current entry is the
 *  canvas's, so a step back taken from here would close the canvas instead. */
export const CoveredRouteContext = createContext(false);

export function useRouteCovered(): boolean {
  return useContext(CoveredRouteContext);
}
