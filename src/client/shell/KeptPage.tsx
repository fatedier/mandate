import { Activity, useState, type ReactNode } from "react";
import { useMatch } from "react-router";
import { PageShownContext } from "@/lib/page-shown";

/**
 * A page kept once opened: while another page shows it is hidden, not
 * unmounted (React's Activity), so the way back finds it as it was left.
 * The Personal agent's page is kept (AppShell; its route draws nothing): a
 * report in its panel is not rebuilt, and a rebuilt one stays blank while
 * it fetches its web fonts again — a sandboxed frame's cache goes with it.
 * Hidden, its effects are torn down: it follows nothing and marks nothing
 * seen until it shows again, and the shared header is left to the page shown.
 */
export function KeptPage({ path, children }: { path: string; children: ReactNode }) {
  const here = useMatch(path) !== null;
  const [opened, setOpened] = useState(here);
  if (here && !opened) setOpened(true);
  if (!opened) return null;
  return (
    <Activity mode={here ? "visible" : "hidden"}>
      <PageShownContext.Provider value={here}>{children}</PageShownContext.Provider>
    </Activity>
  );
}
