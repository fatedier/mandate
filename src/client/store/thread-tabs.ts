import { useEffect } from "react";
import { create } from "zustand";
import { api } from "@/lib/api-paths";
import type { ThreadTabDto, ThreadTabsResponse } from "@shared/api-contracts";

/** The threads opened beside the personal agent, as the server keeps them, read when
 *  first asked about, again when the server says they changed
 *  (threadTabsChanged), when a thread is deleted and after a reconnect. Every
 *  request takes a ticket, and an answer is kept only when no later request's
 *  answer is shown: a slow read cannot undo an open or a close sent after it. */
interface ThreadTabsState {
  /** Null until the server's first answer. */
  tabs: ThreadTabDto[] | null;
  /** The last ticket given out; 0 before the tabs were asked about. */
  latest: number;
  /** The ticket of the answer shown. */
  applied: number;
  load(): Promise<void>;
  /** Opens the thread's tab (it stays if it has one); throws the server's reason. */
  add(threadId: string): Promise<void>;
  remove(threadId: string): Promise<void>;
  /** The tabs may have changed: read again, if they were asked about. */
  changed(): void;
}

export const useThreadTabsStore = create<ThreadTabsState>((set, get) => {
  const request = async (url: string, init?: RequestInit): Promise<void> => {
    const ticket = get().latest + 1;
    set({ latest: ticket });
    const res = await fetch(url, init);
    const body = (await res.json().catch(() => null)) as ThreadTabsResponse | null;
    if (!res.ok || !body || !("tabs" in body)) {
      throw new Error(body && "error" in body ? body.error : `HTTP ${res.status}`);
    }
    set((state) => (ticket <= state.applied ? state : { tabs: body.tabs, applied: ticket }));
  };

  return {
    tabs: null,
    latest: 0,
    applied: 0,
    // A read that failed keeps what is shown; the next change or reconnect reads again.
    load: () => request(api.personalThreadTabs).catch(() => {}),
    add: (threadId) => request(api.personalThreadTabs, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ threadId })
    }),
    remove: (threadId) => request(api.personalThreadTab(threadId), { method: "DELETE" }),
    changed: () => {
      if (get().latest > 0) void get().load();
    }
  };
});

const NONE: ThreadTabDto[] = [];

/** The threads opened beside the personal agent, read on first use; empty until they arrive. */
export function useThreadTabs(): ThreadTabDto[] {
  const tabs = useThreadTabsStore((s) => s.tabs);
  useEffect(() => {
    if (useThreadTabsStore.getState().latest === 0) void useThreadTabsStore.getState().load();
  }, []);
  return tabs ?? NONE;
}
