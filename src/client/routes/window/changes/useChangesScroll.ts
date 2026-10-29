import { useEffect, useRef } from "react";
import type { FeatureChangesResponse } from "@shared/api-contracts";

/** Brings a changed file's row in the list into view. */
export function revealRow(path: string): void {
  document.getElementById(`change-${path}`)?.scrollIntoView({ block: "nearest" });
}

/** Where the Changes tab scrolls on its own: to a deep-linked file's row
 *  once loaded, to the open file's row when the list comes back beside the
 *  diff, and to the top of a file opened while drilled in. Returns the ref
 *  the drilled-in file view hangs on. */
export function useChangesScroll({ initialFile, data, drillIn, selected }: {
  initialFile: string | null;
  data: FeatureChangesResponse | null | undefined;
  drillIn: boolean;
  selected: string | null;
}) {
  // Scroll the deep-linked file's list row into view once per initialFile
  // value: the effect depends on `data` (the row exists only after load), so
  // without the guard every refetch would yank the list back to it.
  const hasScrolledRef = useRef<string | null>(null);
  useEffect(() => {
    if (!initialFile || !data) return;
    if (hasScrolledRef.current === initialFile) return;
    const timer = window.setTimeout(() => {
      hasScrolledRef.current = initialFile;
      revealRow(initialFile);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [initialFile, data]);

  // The list back beside the diff (a narrow tab widened): bring the open
  // file's row into view — while drilled in, the list was not on screen. Held
  // until the row exists, then done; only this transition arms it, so a
  // refetch never scrolls the list. Checked after every render, not on chosen
  // triggers: the row can come back by several paths (the list reloading as
  // the tab widens, a retry after an error), and each of them renders.
  const wasDrilledInRef = useRef(drillIn);
  const revealRef = useRef(false);
  useEffect(() => {
    if (wasDrilledInRef.current && !drillIn) revealRef.current = true;
    wasDrilledInRef.current = drillIn;
    if (drillIn || !selected) {
      revealRef.current = false;
      return;
    }
    if (!revealRef.current) return;
    const row = document.getElementById(`change-${selected}`);
    if (!row) return;
    revealRef.current = false;
    row.scrollIntoView({ block: "nearest" });
  });

  // Opening a file while drilled in (a tap, prev/next, a deep link) brings
  // the file view to the top of its scroller: the pinned bar under the app
  // bar and the diff after it, instead of below the page header, tabs and
  // toolbar (the diff began 44% down a phone). Those are a scroll up away.
  // The view is at least a screen tall so the scroll can happen at once,
  // before the patch arrives and makes the page long enough to allow it.
  // Only an opening counts: narrowing into drill-in with the file already on
  // screen beside the list keeps the reader where they were.
  const fileViewRef = useRef<HTMLDivElement>(null);
  const openPath = drillIn && selected && data?.files.some((f) => f.path === selected) ? selected : null;
  const shownRef = useRef({ drillIn, openPath });
  useEffect(() => {
    const before = shownRef.current;
    shownRef.current = { drillIn, openPath };
    if (openPath && openPath !== before.openPath && before.drillIn) {
      fileViewRef.current?.scrollIntoView({ block: "start" });
    }
  }, [drillIn, openPath]);

  return fileViewRef;
}
