import { create } from "zustand";

/** The turns this page knows a person stopped, heard as it happens. A stopped
 *  turn's messages say so too (`wakeInterrupted`), but only when read after
 *  it ended, and those of a turn stopped while the page is open were read
 *  before. By wake and not by conversation: a turn's end event can come while
 *  its conversation is still being read, with nothing yet to hold it.
 *
 *  Stop marks its turn at once, as it shows it idle at once. The turn's end
 *  event decides: a turn Stop was pressed on can have ended by itself first. */
interface InterruptedWakesState {
  ids: ReadonlySet<string>;
  /** Stop was pressed on the turn. */
  stopping(wakeId: string): void;
  /** The turn ended, in this status. */
  ended(wakeId: string, status: string): void;
}

function withWake(ids: ReadonlySet<string>, wakeId: string, interrupted: boolean): ReadonlySet<string> {
  if (ids.has(wakeId) === interrupted) return ids;
  const next = new Set(ids);
  if (interrupted) next.add(wakeId);
  else next.delete(wakeId);
  return next;
}

export const useInterruptedWakesStore = create<InterruptedWakesState>((set) => ({
  ids: new Set(),
  stopping: (wakeId) => set((state) => ({ ids: withWake(state.ids, wakeId, true) })),
  ended: (wakeId, status) => set((state) => ({ ids: withWake(state.ids, wakeId, status === "canceled") }))
}));
