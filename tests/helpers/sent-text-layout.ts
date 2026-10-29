/** A layout for the text on a handoff card, which this DOM does not compute.
 *  Every element reports `full` px of text, and a box of `clamped` px while it
 *  carries the two-line clamp (`full` without it), as a browser does. */
export function stubSentTextHeights(heights: { full: number; clamped: number }) {
  const proto = window.HTMLElement.prototype;
  const kept = { scroll: Object.getOwnPropertyDescriptor(proto, "scrollHeight"), client: Object.getOwnPropertyDescriptor(proto, "clientHeight") };
  Object.defineProperty(proto, "scrollHeight", { configurable: true, get: () => heights.full });
  Object.defineProperty(proto, "clientHeight", {
    configurable: true,
    get(this: HTMLElement) { return this.className.split(/\s+/).includes("line-clamp-2") ? heights.clamped : heights.full; }
  });
  return {
    restore() {
      if (kept.scroll) Object.defineProperty(proto, "scrollHeight", kept.scroll); else delete (proto as unknown as Record<string, unknown>).scrollHeight;
      if (kept.client) Object.defineProperty(proto, "clientHeight", kept.client); else delete (proto as unknown as Record<string, unknown>).clientHeight;
    }
  };
}
