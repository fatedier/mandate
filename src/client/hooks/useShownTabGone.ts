import { useEffect, useRef } from "react";

/** The nearest tab before `tabId` in the row as it stood (`was`) that the
 *  row still has; the fixed first one when none is left. Several can go at
 *  once (closed elsewhere while this device was not listening). */
function before(was: readonly string[], tabId: string, rowNow: readonly string[], home: string): string {
  for (let index = was.indexOf(tabId) - 1; index >= 0; index -= 1) {
    if (rowNow.includes(was[index]!)) return was[index]!;
  }
  return home;
}

/** A right panel's tabs kept on the server (replies, threads): a shown one
 *  gone from the server's list (closed here or on another device) is told to
 *  the panel (`gone`) with the tab before it, in the row as it stood. Only
 *  between two lists the server gave (`loaded`): before the first, a saved
 *  tab is not known to be gone. `row`: the panel's closable tabs up to and
 *  including these, in order; `owns`: whether a tab is one of these (a
 *  function that never changes). */
export function useShownTabGone({ row, loaded, active, home, gone, owns }: {
  row: readonly string[];
  loaded: boolean;
  active: string;
  home: string;
  gone: (tabId: string, before: string) => void;
  owns: (tabId: string) => boolean;
}): void {
  const previous = useRef<readonly string[] | null>(null);
  const rowKey = row.join("\n");
  useEffect(() => {
    const rowNow = rowKey ? rowKey.split("\n") : [];
    const was = previous.current;
    previous.current = loaded ? rowNow : null;
    if (owns(active) && was?.includes(active) && !rowNow.includes(active)) gone(active, before(was, active, rowNow, home));
  }, [rowKey, loaded, active, home, gone, owns]);
}
