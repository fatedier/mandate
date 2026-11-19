import { create } from "zustand";
import type { ThreadStatusSnapshotDto, WaitingEntryDto } from "@shared/api/thread-status";
import type { ThreadDot } from "@shared/thread-dot";

/** The server's status snapshot: each open manager thread's state and what
 *  waits on the user. The client draws it and works none of it out. */
interface ThreadStatusState {
  states: ReadonlyMap<string, ThreadDot>;
  waiting: readonly WaitingEntryDto[];
  /** A snapshot replaces the last one whole: a thread it leaves out is gone. */
  replace(snapshot: ThreadStatusSnapshotDto): void;
}

export const useThreadStatusStore = create<ThreadStatusState>((set) => ({
  states: new Map(),
  waiting: [],
  replace: (snapshot) => set({
    states: new Map(snapshot.threads.map((thread) => [thread.threadId, thread.state])),
    waiting: snapshot.waiting
  })
}));
