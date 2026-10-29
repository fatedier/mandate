import { create } from "zustand";
import type { ThreadModelDto } from "@shared/api-contracts";

/** Each thread's model as its composer shows it (Default, its pick, the
 *  choices), read from the server; `revision` is bumped when the server says
 *  a thread's model changed (agentThreadModelChanged) or the stream comes
 *  back (a change may have gone unheard), which reads it again. Each request
 *  takes a ticket: an answer is kept only when it is newer than the one shown,
 *  so a slow read cannot undo a choice sent after it, and a later request that
 *  failed does not throw away an earlier one's answer. */
interface ThreadModelsState {
  byThread: Map<string, ThreadModelDto>;
  revision: Map<string, number>;
  /** Each thread's last ticket given out. */
  latest: Map<string, number>;
  /** The ticket of each thread's answer shown. */
  applied: Map<string, number>;
  /** Each thread's last write, settled or not. */
  writes: Map<string, Promise<void>>;
  /** Settles once the thread's writes on their way have: a read waits for
   *  them, as one begun before the server takes a write would answer the old
   *  model as the newer. */
  afterWrites(threadId: string): Promise<void>;
  /** Runs a write once the thread's earlier ones have settled: two on their
   *  way at once would race to the server and could leave the earlier one
   *  standing. */
  queueWrite(threadId: string, run: () => Promise<void>): Promise<void>;
  /** A request about to go out: its ticket. */
  ticket(threadId: string): number;
  /** Its answer, kept only when no later request's answer is shown. */
  put(threadId: string, model: ThreadModelDto, ticket: number): void;
  changed(threadId: string): void;
  /** Every shown thread's, after a reconnect. */
  changedAll(): void;
}

export const useThreadModelsStore = create<ThreadModelsState>((set, get) => ({
  byThread: new Map(),
  revision: new Map(),
  latest: new Map(),
  applied: new Map(),
  writes: new Map(),
  // One that failed does not hold up the next.
  afterWrites: (threadId) => (get().writes.get(threadId) ?? Promise.resolve()).catch(() => {}),
  queueWrite: (threadId, run) => {
    const write = get().afterWrites(threadId).then(run);
    const writes = new Map(get().writes);
    writes.set(threadId, write);
    set({ writes });
    return write;
  },
  ticket: (threadId) => {
    const next = (get().latest.get(threadId) ?? 0) + 1;
    const latest = new Map(get().latest);
    latest.set(threadId, next);
    set({ latest });
    return next;
  },
  put: (threadId, model, ticket) => set((state) => {
    if (ticket <= (state.applied.get(threadId) ?? 0)) return state;
    const byThread = new Map(state.byThread);
    byThread.set(threadId, model);
    const applied = new Map(state.applied);
    applied.set(threadId, ticket);
    return { byThread, applied };
  }),
  changed: (threadId) => set((state) => {
    const revision = new Map(state.revision);
    revision.set(threadId, (revision.get(threadId) ?? 0) + 1);
    return { revision };
  }),
  // Every thread a control asked about, answered or not: one whose first
  // read failed shows nothing until it reads again.
  changedAll: () => set((state) => {
    if (state.latest.size === 0) return state;
    const revision = new Map(state.revision);
    for (const threadId of state.latest.keys()) revision.set(threadId, (revision.get(threadId) ?? 0) + 1);
    return { revision };
  })
}));
