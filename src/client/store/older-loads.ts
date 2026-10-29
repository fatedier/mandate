import { create } from "zustand";

export type OlderLoad = { status: "loading" } | { status: "failed"; error: string };

interface OlderLoadsState {
  byThread: ReadonlyMap<string, OlderLoad>;
  /** Null when the conversation's last load is over and went through. */
  set: (threadId: string, load: OlderLoad | null) => void;
}

/**
 * Each conversation's older-page load, on its way or failed. The
 * conversation's, not its transcript's: a transcript is unmounted when its
 * tab or thread is left, and one mounted again must neither ask a second time
 * for a page on its way (it would land twice) nor retry a failure by itself.
 */
export const useOlderLoadsStore = create<OlderLoadsState>((set) => ({
  byThread: new Map(),
  set: (threadId, load) => set((state) => {
    const byThread = new Map(state.byThread);
    if (load) byThread.set(threadId, load);
    else byThread.delete(threadId);
    return { byThread };
  })
}));
