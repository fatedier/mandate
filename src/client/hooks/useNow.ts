import { useSyncExternalStore } from "react";

const listeners = new Set<() => void>();
let now = Date.now();
let timer: ReturnType<typeof setInterval> | null = null;

function tick() {
  now = Date.now();
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (timer === null) {
    tick();
    timer = setInterval(tick, 15_000);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };
}

const getNow = () => now;

/** One local timer for age labels, independent of network/state updates. */
export function useNow(): number {
  return useSyncExternalStore(subscribe, getNow, getNow);
}
