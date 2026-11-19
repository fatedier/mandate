import { arrayMove } from "@dnd-kit/sortable";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

export const TERMINAL_TABS_STORAGE_KEY = "mandate.terminal-tabs.v1";

/** A pane opened on the Terminals page: its id and pid (tmux reuses ids),
 *  and the name its tab last read, for when the list no longer has it. */
export interface OpenTerminal {
  paneId: string;
  pid: number;
  name?: string;
}

interface TerminalTabsState {
  /** The panes opened on the Terminals page, in the order opened: each a
   *  tab after the pins (while it is not one of them) until it is closed.
   *  Kept in this browser; the pins are the server's, shared by every
   *  device. */
  open: OpenTerminal[];
  /** At the end, unless it is open already, with the name its tab shows. */
  add(paneId: string, pid: number, name?: string): void;
  close(paneId: string, pid: number): void;
  /** Dragged (or moved) onto another open tab: takes that one's place. */
  move(paneId: string, pid: number, overPaneId: string, overPid: number): void;
  /** Keeps the names the list gives the open panes. */
  rename(names: ReadonlyArray<{ paneId: string; pid: number; name: string }>): void;
}

const same = (a: { paneId: string; pid: number }, paneId: string, pid: number) => a.paneId === paneId && a.pid === pid;

// Every set writes the whole list to storage, over what another window of
// this browser wrote: only a change sets, and each window reads the others'
// writes (below) before it makes its own.
export const useTerminalTabsStore = create<TerminalTabsState>()(persist((set, get) => ({
  open: [],
  add: (paneId, pid, name) => {
    if (get().open.some((t) => same(t, paneId, pid))) return;
    set({ open: [...get().open, name ? { paneId, pid, name } : { paneId, pid }] });
  },
  close: (paneId, pid) => {
    if (!get().open.some((t) => same(t, paneId, pid))) return;
    set({ open: get().open.filter((t) => !same(t, paneId, pid)) });
  },
  move: (paneId, pid, overPaneId, overPid) => {
    const open = get().open;
    const from = open.findIndex((t) => same(t, paneId, pid));
    const to = open.findIndex((t) => same(t, overPaneId, overPid));
    if (from < 0 || to < 0 || from === to) return;
    set({ open: arrayMove(open, from, to) });
  },
  rename: (names) => {
    let changed = false;
    const open = get().open.map((t) => {
      const name = names.find((n) => same(n, t.paneId, t.pid))?.name;
      if (!name || name === t.name) return t;
      changed = true;
      return { ...t, name };
    });
    if (changed) set({ open });
  }
}), {
  name: TERMINAL_TABS_STORAGE_KEY,
  storage: createJSONStorage(() => localStorage),
  partialize: (state) => ({ open: state.open })
}));

// Another window of this browser opened or closed a tab: take its list.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key === TERMINAL_TABS_STORAGE_KEY) void useTerminalTabsStore.persist.rehydrate();
  });
}
