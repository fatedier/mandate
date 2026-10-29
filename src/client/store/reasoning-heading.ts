import { create } from "zustand";

/** The heading each running wake's reasoning summary has reached, heard over
 *  SSE (agentReasoningHeading), for the chat's working line. Dropped when the
 *  wake finishes, and all on a reconnect; a page that loads (or reconnects)
 *  mid-step shows "Working" until the next heading arrives. A step's own
 *  message clears its wake's heading (the thought is over). Bounded, so wakes whose finish was missed cannot pile up. */
const KEEP = 20;

interface ReasoningHeadingState {
  byWake: Map<string, string>;
  set(wakeId: string, heading: string): void;
  clear(wakeId: string): void;
  /** On a reconnect: a wake that finished while the stream was down never said so. */
  clearAll(): void;
}

export const useReasoningHeadingStore = create<ReasoningHeadingState>((set) => ({
  byWake: new Map(),
  set: (wakeId, heading) => set((state) => {
    if (state.byWake.get(wakeId) === heading) return state;
    const byWake = new Map(state.byWake);
    byWake.delete(wakeId);
    byWake.set(wakeId, heading);
    while (byWake.size > KEEP) byWake.delete(byWake.keys().next().value!);
    return { byWake };
  }),
  clear: (wakeId) => set((state) => {
    if (!state.byWake.has(wakeId)) return state;
    const byWake = new Map(state.byWake);
    byWake.delete(wakeId);
    return { byWake };
  }),
  clearAll: () => set((state) => (state.byWake.size === 0 ? state : { byWake: new Map() }))
}));
