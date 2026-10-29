import { useLayoutEffect, useRef, type RefObject } from "react";
import { motionAllowed } from "@/lib/motion";

/**
 * Once another tab is chosen, what follows `after` (the panel it shows)
 * fades in, 150 ms, before it is painted. What showed as the view opened
 * does not move; asked for less motion, it is just there.
 */
export function useTabFade(after: RefObject<HTMLElement | null>, chosen: string | null): void {
  const last = useRef(chosen);
  useLayoutEffect(() => {
    if (last.current === chosen) return;
    last.current = chosen;
    if (!motionAllowed()) return;
    for (let el = after.current?.nextElementSibling; el; el = el.nextElementSibling) {
      el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 150, easing: "linear" });
    }
  }, [after, chosen]);
}
