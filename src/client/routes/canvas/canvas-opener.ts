import { createContext, useCallback, useContext } from "react";
import { useLocation, useNavigate } from "react-router";

/** How the page around asks to show a canvas: a page with a panel (a thread,
 *  Your agent, on a desktop) opens it in a tab there (CanvasOpenerProvider). */
export const CanvasOpenerContext = createContext<((canvasId: string) => void) | null>(null);

/** Opens a canvas: in the page's panel when the page has one, else over the
 *  page, a step in the history (CanvasModal), as before. `path`: the canvas's
 *  address as it was written, query and fragment kept, for the latter. */
export function useOpenCanvas(): (canvasId: string, path?: string) => void {
  const open = useContext(CanvasOpenerContext);
  const navigate = useNavigate();
  const location = useLocation();
  return useCallback((canvasId: string, path?: string) => {
    if (open) open(canvasId);
    else navigate(path ?? `/canvas/${canvasId}`, { state: { backgroundLocation: location } });
  }, [open, navigate, location]);
}
