import { createContext, useCallback, useContext } from "react";
import { useLocation, useNavigate, type Location } from "react-router";
import { fileRoute, type FileTarget } from "@/lib/file-link";

/** How the page around asks to show a file: a page with a panel (a thread,
 *  the personal agent, on a desktop) opens it in a tab there (FileOpenerProvider). */
export const FileOpenerContext = createContext<((target: FileTarget) => void) | null>(null);

/** Opens a file: in the page's panel when the page has one, else over the
 *  page, a step in the history (FileModal), as a canvas opens. Opened from
 *  something already over the page, it goes over that same page. */
/** The page a location is drawn over (a canvas or a file over it), or the
 *  location itself. */
export function pageBehind(location: Location): Location {
  const behind = (location.state as { backgroundLocation?: Location } | null)?.backgroundLocation;
  return behind && typeof behind === "object" && typeof behind.pathname === "string" ? behind : location;
}

export function useOpenFile(): (target: FileTarget) => void {
  const open = useContext(FileOpenerContext);
  const navigate = useNavigate();
  const location = useLocation();
  return useCallback((target: FileTarget) => {
    if (open) open(target);
    else navigate(fileRoute(target), { state: { backgroundLocation: pageBehind(location) } });
  }, [open, navigate, location]);
}
