import { useLayoutEffect, useRef, type RefObject } from "react";
import { motionAllowed } from "@/lib/motion";

/** A row's slide to its new place: 240 ms on the house curve. */
const SLIDE: KeyframeAnimationOptions = { duration: 240, easing: "cubic-bezier(0.2, 0, 0, 1)" };

/**
 * Rows of a list that change their place slide there, before they are
 * painted. After each commit every row's top within the list is noted (the
 * list is positioned, so its own moves and scrolling count for nothing); a
 * row whose top moved since the commit before is played from where it was.
 * A row that comes is just there, and nothing runs between commits: no
 * timers, no observers. Asked for less motion, rows are just in their new
 * place. Rows are the list's children with `data-slide-key`.
 */
export function useSlideOnReorder(list: RefObject<HTMLElement | null>): void {
  const tops = useRef(new Map<string, number>());
  useLayoutEffect(() => {
    const el = list.current;
    const now = new Map<string, number>();
    if (!el) {
      tops.current = now;
      return;
    }
    const moves = motionAllowed();
    for (const row of el.children) {
      if (!(row instanceof HTMLElement) || !row.dataset.slideKey) continue;
      const top = row.offsetTop;
      now.set(row.dataset.slideKey, top);
      const was = tops.current.get(row.dataset.slideKey);
      if (moves && was !== undefined && was !== top) {
        row.animate([{ transform: `translateY(${was - top}px)` }, { transform: "none" }], SLIDE);
      }
    }
    tops.current = now;
  });
}
