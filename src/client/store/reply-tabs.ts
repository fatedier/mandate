import { useEffect } from "react";
import { create } from "zustand";
import { api } from "@/lib/api-paths";
import type { ReplyTabDto, ReplyTabsResponse } from "@shared/api-contracts";

/** Each thread's reply tabs as the server keeps them (the replies opened in
 *  its right panel), read when a thread is first asked about, again when the
 *  server says they changed (replyTabsChanged) and after a reconnect. Every
 *  request takes a ticket, and an answer is kept only when no later request's
 *  answer is shown: a slow read cannot undo an add or a close sent after it. */
interface ReplyTabsState {
  byThread: Map<string, ReplyTabDto[]>;
  /** Each thread's last ticket given out: the threads asked about. */
  latest: Map<string, number>;
  /** The ticket of each thread's answer shown. */
  applied: Map<string, number>;
  load(threadId: string): Promise<void>;
  /** The reply's tab (an existing one when it has one); throws the server's reason. */
  add(threadId: string, messageId: string, text: string): Promise<ReplyTabDto>;
  remove(threadId: string, tabId: string): Promise<void>;
  /** The server said this thread's tabs changed: read again, if it was asked about. */
  changed(threadId: string): void;
  /** After a reconnect: every thread asked about. */
  changedAll(): void;
}

export const useReplyTabsStore = create<ReplyTabsState>((set, get) => {
  /** Sends one request for the thread and keeps its list if it is the newest
   *  answer; resolves the list it answered, throws its error. */
  const request = async (threadId: string, url: string, init?: RequestInit): Promise<ReplyTabDto[]> => {
    const ticket = (get().latest.get(threadId) ?? 0) + 1;
    set((state) => ({ latest: new Map(state.latest).set(threadId, ticket) }));
    const res = await fetch(url, init);
    const body = (await res.json().catch(() => null)) as ReplyTabsResponse | null;
    if (!res.ok || !body || !("tabs" in body)) {
      throw new Error(body && "error" in body ? body.error : `HTTP ${res.status}`);
    }
    set((state) => {
      if (ticket <= (state.applied.get(threadId) ?? 0)) return state;
      return { byThread: new Map(state.byThread).set(threadId, body.tabs), applied: new Map(state.applied).set(threadId, ticket) };
    });
    return body.tabs;
  };
  const json = (method: string, body?: unknown): RequestInit => ({
    method,
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
  });

  return {
    byThread: new Map(),
    latest: new Map(),
    applied: new Map(),
    // A read that failed keeps what is shown; the next change or reconnect reads again.
    load: (threadId) => request(threadId, api.threadReplyTabs(threadId)).then(() => {}, () => {}),
    add: async (threadId, messageId, text) => {
      const tabs = await request(threadId, api.threadReplyTabs(threadId), json("POST", { messageId, text }));
      const tab = tabs.find((t) => t.messageId === messageId);
      if (!tab) throw new Error("The reply's tab is missing from the server's answer.");
      return tab;
    },
    remove: async (threadId, tabId) => {
      await request(threadId, api.threadReplyTab(threadId, tabId), json("DELETE"));
    },
    changed: (threadId) => {
      if (get().latest.has(threadId)) void get().load(threadId);
    },
    changedAll: () => {
      for (const threadId of get().latest.keys()) void get().load(threadId);
    }
  };
});

const NONE: ReplyTabDto[] = [];

/** A thread's reply tabs, read on first use; empty until they arrive. */
export function useReplyTabs(threadId: string): ReplyTabDto[] {
  const tabs = useReplyTabsStore((s) => s.byThread.get(threadId));
  useEffect(() => {
    if (!useReplyTabsStore.getState().latest.has(threadId)) void useReplyTabsStore.getState().load(threadId);
  }, [threadId]);
  return tabs ?? NONE;
}
