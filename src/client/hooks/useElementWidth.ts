import { useLayoutEffect, useState } from "react";

/** An element's width, read before paint and again on every resize: pass the
 *  returned callback as the element's `ref`. 0 until measured — happy-dom has
 *  no layout, and a hidden element measures 0, which is kept as "unknown"
 *  rather than taken for a size. */
export function useElementWidth<T extends HTMLElement>(): [(element: T | null) => void, number] {
  const [element, setElement] = useState<T | null>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    if (!element) return;
    const measure = () => {
      const next = element.getBoundingClientRect().width;
      if (next > 0) setWidth((previous) => (Math.abs(previous - next) < 0.5 ? previous : next));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);
  return [setElement, width];
}
