/** Which sides of a horizontally scrolled box have content past its edges. */
export type ScrollMore = "none" | "left" | "right" | "both";

/** Half a pixel of slack either way: layout is sub-pixel, and a row scrolled
 *  to its end can stop 0.5px short of scrollWidth. */
export function scrollEdges({ scrollLeft, clientWidth, scrollWidth }: {
  scrollLeft: number;
  clientWidth: number;
  scrollWidth: number;
}): ScrollMore {
  const left = scrollLeft > 0.5;
  const right = scrollLeft + clientWidth < scrollWidth - 0.5;
  return left && right ? "both" : left ? "left" : right ? "right" : "none";
}

/** The edge fade's width in .scroll-x-edges and .fade-x-edges (1.5rem). */
export const EDGE_FADE_PX = 24;

/** The scrollLeft that brings a child spanning [start, end) of a row's
 *  scroll width clear of the edge fades; the current one when it already
 *  is. Never past the row's ends. */
export function revealScrollLeft({ start, end, scrollLeft, clientWidth, scrollWidth }: {
  start: number;
  end: number;
  scrollLeft: number;
  clientWidth: number;
  scrollWidth: number;
}): number {
  const max = Math.max(0, scrollWidth - clientWidth);
  if (start < scrollLeft + EDGE_FADE_PX) return Math.min(max, Math.max(0, start - EDGE_FADE_PX));
  if (end > scrollLeft + clientWidth - EDGE_FADE_PX) return Math.max(0, Math.min(max, end - clientWidth + EDGE_FADE_PX));
  return scrollLeft;
}
