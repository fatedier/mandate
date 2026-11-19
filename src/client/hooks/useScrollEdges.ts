import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { revealScrollLeft, scrollEdges, type ScrollMore } from "@/lib/scroll-edges";

/** Which sides of a sideways-scrolling row have content past its edges, kept
 *  current as it scrolls and resizes: the row's `data-more`, which
 *  `.scroll-x-edges` and `.fade-x-edges` turn into its edge fade. A row that
 *  fits reads "none". `onFocus`, on the row, scrolls a child reached by
 *  keyboard clear of the fades; the row must be its children's offsetParent
 *  (positioned).
 *
 *  A row of tabs passes `selected`, whatever tells one selection (and one
 *  set of tabs) from the next: when it changes, and when the row resizes, the
 *  selected child (aria-selected or aria-current) is scrolled clear of the
 *  fades as well. Only the row scrolls, never the page. */
export function useScrollEdges<T extends HTMLElement>(selected?: unknown) {
  const ref = useRef<T | null>(null);
  const [more, setMore] = useState<ScrollMore>("none");
  const follows = selected !== undefined;

  const reveal = useCallback((child: HTMLElement | null) => {
    const row = ref.current;
    if (!row || !child) return;
    const next = revealScrollLeft({
      start: child.offsetLeft,
      end: child.offsetLeft + child.offsetWidth,
      scrollLeft: row.scrollLeft,
      clientWidth: row.clientWidth,
      scrollWidth: row.scrollWidth
    });
    if (next !== row.scrollLeft) row.scrollLeft = next;
  }, []);
  /** The selected child into view, then the edges. */
  const settle = useCallback(() => {
    const row = ref.current;
    if (!row) return;
    if (follows) reveal(row.querySelector<HTMLElement>('[aria-current="page"], [aria-selected="true"]'));
    setMore(scrollEdges(row));
  }, [follows, reveal]);

  // Before the paint, so the first frame already has its fade and its
  // selected child in view.
  useLayoutEffect(settle, [selected, settle]);
  useLayoutEffect(() => {
    const row = ref.current;
    if (!row) return;
    const measure = () => setMore(scrollEdges(row));
    row.addEventListener("scroll", measure, { passive: true });
    // A resize (a phone turned, a window narrowed) can push the selected
    // child out while the row stays mounted.
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(settle);
    observer?.observe(row);
    return () => {
      row.removeEventListener("scroll", measure);
      observer?.disconnect();
    };
  }, [settle]);

  // Only by keyboard (:focus-visible): a tap focuses on pointerdown, and
  // scrolling then would move the control from under the finger.
  const onFocus = useCallback((event: React.FocusEvent<HTMLElement>) => {
    const row = ref.current;
    const target = event.target as HTMLElement;
    // A portal in the row's React tree (an open select's options) bubbles
    // its focus here too; its offsets are not the row's.
    if (!row || target === row || !row.contains(target) || !target.matches(":focus-visible")) return;
    // The row's own child: a control inside it (a tab's Close) brings the
    // whole of that child with it.
    let child = target;
    while (child.parentElement && child.parentElement !== row) child = child.parentElement;
    reveal(child);
  }, [reveal]);
  return { ref, more, onFocus };
}
