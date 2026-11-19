import { create } from "zustand";

/** When each running wake's streaming reply last moved (client clock), heard
 *  over SSE, for the chat's working line: it steps aside while the reply
 *  moves, and text that has stopped (a preamble before a long tool call, a
 *  stream cut off) gives it back. Dropped when the wake finishes, and all on
 *  a reconnect. Bounded, so wakes whose finish was missed cannot pile up. */
const KEEP = 20;

interface ReplyActivityState {
  byWake: Map<string, number>;
  touch(wakeId: string): void;
  clear(wakeId: string): void;
  /** On a reconnect: a wake that finished while the stream was down never said so. */
  clearAll(): void;
}

export const useReplyActivityStore = create<ReplyActivityState>((set) => ({
  byWake: new Map(),
  touch: (wakeId) => set((state) => {
    const byWake = new Map(state.byWake);
    byWake.delete(wakeId);
    byWake.set(wakeId, Date.now());
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
