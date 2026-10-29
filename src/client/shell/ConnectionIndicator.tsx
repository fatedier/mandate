import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

/** The live stream's state, straight after the page's title in the header —
 *  where a document carries "Trying to connect". It covers nothing: the title
 *  gives it room, and the header's actions stay where they are. The word is
 *  never cut: the title gives way to it first (with a long title it used to
 *  lose a fraction of a pixel and read "Reconnectin…"); only once the title
 *  has nothing left does the note give way, and then a spinner stands in for
 *  the word. A header too narrow for the word (under 22rem) shows the spinner
 *  from the start. Screen readers always hear the word. It is shown while
 *  useReconnecting() says so. */
export function ConnectionIndicator() {
  const word = useRef<HTMLSpanElement>(null);
  const cut = useCut(word);
  return (
    <span
      data-slot="connection-indicator"
      role="status"
      // The header's title shrinks ten thousand times as hard while this shows,
      // so the note gives way only once the title has nothing left. (A tiny
      // shrink here instead would not do: once the title stops, flexbox hands
      // out only that fraction of the overflow and the actions get pushed.)
      className="flex min-w-0 items-center gap-1.5 whitespace-nowrap text-xs text-faint"
    >
      <span aria-hidden className="shrink-0">·</span>
      <span className="sr-only">Reconnecting…</span>
      {/* The word keeps its place even while the spinner stands in for it,
          so the row lays out the same either way and cannot flip back. */}
      <span aria-hidden className="relative flex min-w-0 items-center overflow-hidden">
        <Loader2 className={cn("size-3 shrink-0 animate-spin", cut ? "absolute left-0" : "hidden", "@max-[22rem]:static @max-[22rem]:block")} />
        <span ref={word} data-slot="connection-word" className={cn("min-w-0 overflow-hidden", cut && "invisible", "@max-[22rem]:hidden")}>
          Reconnecting…
        </span>
      </span>
    </span>
  );
}

/** Whether the word is cut by more than a pixel (less is a sliver of the
 *  ellipsis' side bearing, not a letter). Measured as laid out, on every
 *  resize; the first observation arrives as soon as it is observed. */
function useCut(ref: RefObject<HTMLElement | null>): boolean {
  const [cut, setCut] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      const range = document.createRange();
      range.selectNodeContents(el);
      setCut(range.getBoundingClientRect().width - el.getBoundingClientRect().width > 1);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return cut;
}
