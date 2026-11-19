import { createContext, useContext } from "react";

export const RouteDialogCloseContext = createContext<(() => void) | null>(null);

/** Closes the RouteDialog around (one step back); null outside one. */
export function useRouteDialogClose(): (() => void) | null {
  return useContext(RouteDialogCloseContext);
}
