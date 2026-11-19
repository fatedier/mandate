import { useSyncExternalStore } from "react";

function subscribe(onChange: () => void) {
  document.addEventListener("fullscreenchange", onChange);
  return () => document.removeEventListener("fullscreenchange", onChange);
}
const isActive = () => document.fullscreenElement !== null;
const serverSnapshot = () => false;

/** The browser's own full screen for the whole page. `active` follows the
 *  real state, however it ends (Android's back gesture, Esc, the page);
 *  `supported` is false where the page may not ask (iPhone Safari, an
 *  embedding that forbids it). `toggle` must run inside a tap or click: a
 *  page may only request full screen with a user gesture. It keeps the
 *  phone's navigation bar (navigationUI "show"): from Android 12 the bar
 *  comes back whenever the keyboard opens, and its coming and going made
 *  Chrome redraw the whole screen, a flash on every tap into a text field. */
export function useFullscreen() {
  const active = useSyncExternalStore(subscribe, isActive, serverSnapshot);
  const supported = typeof document !== "undefined" && document.fullscreenEnabled === true;
  const toggle = () => {
    // A refusal (no gesture, a policy) leaves the page as it was.
    const done = document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen({ navigationUI: "show" });
    done.catch(() => {});
  };
  return { active, supported, toggle };
}
