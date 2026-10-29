import { useEffect } from "react";
import { useRouteCovered } from "@/lib/covered-route";

/** What holds a task's steps closes once a canvas opened from them covers
 *  the page: a canvas path in its reply is a link that opens the canvas as
 *  a modal route over the page. */
export function useCloseWhenCovered(open: boolean, close: () => void): void {
  const covered = useRouteCovered();
  useEffect(() => {
    if (covered && open) close();
  }, [covered, open, close]);
}
