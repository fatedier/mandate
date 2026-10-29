import type { ReactNode } from "react";
import { CanvasOpenerContext } from "./canvas-opener";

/** A page with a panel: every way into a canvas inside it (useOpenCanvas)
 *  asks `open` instead of opening the canvas over the page. */
export function CanvasOpenerProvider({ open, children }: { open: (canvasId: string) => void; children: ReactNode }) {
  return <CanvasOpenerContext.Provider value={open}>{children}</CanvasOpenerContext.Provider>;
}
