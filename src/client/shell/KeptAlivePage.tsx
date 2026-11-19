import { useEffect, useState, type ReactNode } from "react";
import { matchPath, useLocation } from "react-router";
import { PageShownContext } from "@/lib/page-shown";

/**
 * A page kept running for a while after it is left: unlike KeptPage, which
 * pauses a hidden page, its effects go on (the Terminals page's connections
 * stay open, so the way back shows its terminals at once). Hidden by
 * visibility over the place pages take, so what it holds keeps its size, and
 * clipped to it, so nothing of it adds to the shown page's scrolling; out of
 * reach (inert); PageShownContext false, so the shell's shared places are
 * the page shown's. Let go `keepMs` after it was left, so it does not stay
 * open for good; the next visit starts it again.
 */
export function KeptAlivePage({ paths, keepMs, children }: { paths: readonly string[]; keepMs: number; children: ReactNode }) {
  const { pathname } = useLocation();
  const here = paths.some((path) => matchPath(path, pathname) !== null);
  const [alive, setAlive] = useState(here);
  if (here && !alive) setAlive(true);
  useEffect(() => {
    if (here || !alive) return undefined;
    const timer = window.setTimeout(() => setAlive(false), keepMs);
    return () => window.clearTimeout(timer);
  }, [here, alive, keepMs]);
  if (!alive) return null;
  return (
    <div
      inert={!here}
      className={here ? "flex min-h-0 flex-1 flex-col" : "pointer-events-none invisible absolute inset-0 flex flex-col overflow-hidden"}
    >
      <PageShownContext.Provider value={here}>{children}</PageShownContext.Provider>
    </div>
  );
}
