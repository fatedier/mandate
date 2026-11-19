import { useEffect } from "react";
import { hasOpenKeyboardOverlay } from "./keyboard-targets";

/**
 * The phone's Back closes what is open over the page, as Esc does on a
 * desktop, instead of leaving the page under it. The browser sends Back to a
 * close watcher (HTML's CloseWatcher: Chrome and Firefox on Android) and the
 * watcher presses Esc: the overlays already close on it, the topmost first (a
 * menu before the sheet it opened from), and one that refuses Esc while it
 * saves refuses Back as well. iOS has no such Back (its edge swipe is history
 * navigation); a browser without CloseWatcher keeps Back as it was.
 *
 * One watcher stands for every open overlay, held while any is mounted (each
 * shared overlay's content holds a `CloseRequests`) and made again after each
 * Back that leaves one open. Esc itself never reaches it: an overlay that
 * takes Esc cancels the key, and a cancelled Esc is no close request.
 */

interface CloseWatcherLike {
  onclose: ((event: Event) => void) | null;
  destroy(): void;
}
type CloseWatcherConstructor = new () => CloseWatcherLike;

let mounted = 0;
let watcher: CloseWatcherLike | null = null;

function watch(): void {
  const CloseWatcher = (globalThis as { CloseWatcher?: CloseWatcherConstructor }).CloseWatcher;
  if (watcher || !CloseWatcher) return;
  const current = new CloseWatcher();
  watcher = current;
  current.onclose = () => {
    if (watcher === current) watcher = null;
    // Back while the last overlay is on its way out (still mounted, already
    // closed): nothing is left to close, so it is the page's Back.
    if (!hasOpenKeyboardOverlay()) {
      window.history.back();
      return;
    }
    // Dispatched on the body, not the focused element: a terminal that kept
    // focus would type the Esc. The overlays hear Esc on the document.
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true, cancelable: true }));
    watch();
  };
}

/** Placed inside an overlay's content, which mounts only while the overlay
 *  shows: while it is mounted, Back closes the topmost overlay. */
export function CloseRequests(): null {
  useEffect(() => {
    mounted += 1;
    watch();
    return () => {
      mounted -= 1;
      if (mounted === 0 && watcher) {
        watcher.destroy();
        watcher = null;
      }
    };
  }, []);
  return null;
}
