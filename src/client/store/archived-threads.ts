import { create } from "zustand";
import type { ThreadState } from "./agent-chat";

interface ArchivedThreadsState {
  byId: ReadonlyMap<string, ThreadState>;
  /** Replaces an archived thread with what `update` makes of it. */
  update: (threadId: string, update: (current: ThreadState | undefined) => ThreadState | undefined) => void;
}

/**
 * Archived workers' conversations, as read so far. The conversation's, not
 * its Chat tab's: the tab unmounts when left, and an older page on its way
 * must land where the tab opened again shows it (older-loads.ts keeps that
 * page's load the conversation's too). An archived conversation does not
 * change, so what was read is shown again without reading it again.
 */
export const useArchivedThreadsStore = create<ArchivedThreadsState>((set) => ({
  byId: new Map(),
  update: (threadId, update) => set((state) => {
    const next = update(state.byId.get(threadId));
    if (next === state.byId.get(threadId)) return state;
    const byId = new Map(state.byId);
    if (next) byId.set(threadId, next);
    else byId.delete(threadId);
    return { byId };
  })
}));
