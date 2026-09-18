import { useSyncExternalStore } from "react";
import { isTauriRuntime } from "@/lib/runtime";

/** Whether the desktop window is in macOS fullscreen, where the system hides
 *  the traffic lights — so the title strip that exists for them has nothing
 *  to hold and hides too (a Space-wide window with an empty 28px band on top
 *  read as a bug). Tauri has no fullscreen event; the state is re-read after
 *  every resize, which entering and leaving fullscreen always cause. */

type Listener = () => void;

export type FullscreenSource = {
  isFullscreen: () => Promise<boolean>;
  /** Resolves with the unsubscribe function, mirroring Tauri's `onResized`. */
  onResized: (handler: () => void) => Promise<() => void>;
};

let fullscreen = false;
const listeners = new Set<Listener>();

function set(next: boolean): void {
  if (next === fullscreen) return;
  fullscreen = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): boolean {
  return fullscreen;
}

/** Tracks the window's fullscreen state from `source`. Returns a teardown that
 *  stops tracking and resets the state, so tests and re-installs start clean.
 *  Reads that resolve after teardown are dropped. */
export function trackDesktopFullscreen(source: FullscreenSource): () => void {
  let live = true;
  const refresh = () => {
    void source.isFullscreen().then((value) => {
      if (live) set(value);
    }).catch(() => {
      // A failed read leaves the last known state; the next resize retries.
    });
  };
  refresh();
  let unlisten: (() => void) | null = null;
  void source.onResized(refresh).then((fn) => {
    if (live) unlisten = fn;
    else fn();
  }).catch(() => {
    // Without resize events the state stays at the boot-time read.
  });
  return () => {
    live = false;
    unlisten?.();
    unlisten = null;
    set(false);
  };
}

/** Boot-time wiring: no-op in the browser. */
export function trackDesktopFullscreenIfDesktop(): void {
  if (!isTauriRuntime()) return;
  void import("@tauri-apps/api/window").then(({ getCurrentWindow }) => {
    const win = getCurrentWindow();
    trackDesktopFullscreen({
      isFullscreen: () => win.isFullscreen(),
      onResized: (handler) => win.onResized(handler)
    });
  });
}

export function useDesktopFullscreen(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}
