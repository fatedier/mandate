import { useRef, type PointerEvent } from "react";

/**
 * On a touch screen a tap on a chart's mark first shows its card, and a tap
 * on the mark whose card is showing opens it: a finger has no hover, and the
 * card is where a mark without a label is named. A mouse click, Enter and
 * Space open at once.
 *
 * Whether the card was showing is read when the finger goes down, before
 * the tap's own emulated hover shows it. iOS may send no click at all for a
 * tap whose hover changed the page; the next tap then finds the card
 * showing and opens, as it does elsewhere.
 */
export function useTapToPeek<K>(showing: K | null) {
  const tap = useRef<{ key: K; touch: boolean; shown: boolean } | null>(null);
  return {
    /** For the mark's `onPointerDown`. */
    down(key: K, event: PointerEvent) {
      tap.current = { key, touch: event.pointerType !== "mouse", shown: showing === key };
    },
    /** For the mark's click: whether it opens, or only shows the card. */
    opens(key: K): boolean {
      const last = tap.current;
      tap.current = null;
      return !last || last.key !== key || !last.touch || last.shown;
    }
  };
}
