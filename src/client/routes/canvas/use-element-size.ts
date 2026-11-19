import { useEffect, useState } from "react";
import type { Size } from "./design-camera";

/** An element's content size, following resizes. 0×0 until measured (and in
 *  happy-dom, which has no layout); a hidden element's 0 is not a size. */
export function useElementSize(element: HTMLElement | null): Size {
  const [size, setSize] = useState<Size>({ width: 0, height: 0 });
  useEffect(() => {
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (!rect || rect.width <= 0 || rect.height <= 0) return;
      setSize((previous) =>
        Math.abs(previous.width - rect.width) < 0.5 && Math.abs(previous.height - rect.height) < 0.5
          ? previous
          : { width: rect.width, height: rect.height });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);
  return size;
}
