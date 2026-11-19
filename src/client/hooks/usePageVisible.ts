import { useSyncExternalStore } from "react";

const subscribe = (onChange: () => void) => {
  document.addEventListener("visibilitychange", onChange);
  return () => document.removeEventListener("visibilitychange", onChange);
};
const visible = () => document.visibilityState === "visible";

/** Whether this page is shown: its browser tab is the one in front and its
 *  window is not minimised. A window covered by another app's can still say
 *  it is shown (macOS reports one under a maximised window as visible). */
export function usePageVisible(): boolean {
  return useSyncExternalStore(subscribe, visible, () => true);
}
