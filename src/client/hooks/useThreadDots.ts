import { useThreadStatusStore } from "@/store/thread-status";
import type { ThreadDot } from "@shared/thread-dot";

const NONE: ReadonlyMap<string, ThreadDot> = new Map();

/** Each open thread's state as the sidebar marks it, as the server worked
 *  it out. Switched off (`enabled` false), none, and no store change redraws
 *  it. A thread the server has not named yet reads as idle. */
export function useThreadDots(enabled = true): ReadonlyMap<string, ThreadDot> {
  return useThreadStatusStore((s) => (enabled ? s.states : NONE));
}
