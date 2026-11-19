import { create } from "zustand";
import { apiPath } from "@/lib/api-base";
import { API_PATHS } from "@shared/api/routes";
import type { SideChatDto } from "@shared/api/side-chat";

/** A side chat's page. */
export function sideChatHref(id: string): string {
  return `/agent/side-chats/${encodeURIComponent(id)}`;
}

/** Whether a side chat has a reply the user has not seen. */
export function isSideChatNew(chat: Pick<SideChatDto, "lastVisibleSeq" | "seenSeq">): boolean {
  return chat.lastVisibleSeq > chat.seenSeq;
}

interface SideChatsState {
  /** The open side chats, newest activity first; null until the server's list arrives. */
  sideChats: SideChatDto[] | null;
  replaceAll(list: SideChatDto[]): void;
  upsert(chat: SideChatDto): void;
  remove(id: string): void;
  /** Opens one, forked from the agent's conversation now: its id. Throws why it did not. */
  create(): Promise<string>;
  rename(id: string, title: string): Promise<void>;
  /** Seen up to `seq`: at once here, and told to the server. */
  markSeen(id: string, seq: number): void;
  /** Its summary for the main conversation, written now. Throws why it was not. */
  summary(id: string, signal?: AbortSignal): Promise<string>;
  send(id: string, summary: string, note: string): Promise<void>;
  discard(id: string): Promise<void>;
}

const byActivity = (list: SideChatDto[]) => [...list].sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));

/** The server's answer, or its reason as an Error. */
async function request<T>(url: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(apiPath(url), {
    ...init,
    ...(init.body !== undefined ? { headers: { "content-type": "application/json" } } : {})
  });
  const parsed = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok || typeof parsed.error === "string") throw new Error(parsed.error || `HTTP ${response.status}`);
  return parsed;
}

export const useSideChatsStore = create<SideChatsState>((set, get) => ({
  sideChats: null,
  replaceAll: (list) => set({ sideChats: byActivity(list) }),
  upsert: (chat) => set((state) => ({ sideChats: byActivity([...(state.sideChats ?? []).filter((c) => c.id !== chat.id), chat]) })),
  remove: (id) => set((state) => ({ sideChats: (state.sideChats ?? []).filter((c) => c.id !== id) })),

  create: async () => {
    const { sideChat } = await request<{ sideChat: SideChatDto }>(API_PATHS.sideChats(), { method: "POST" });
    get().upsert(sideChat);
    return sideChat.id;
  },

  rename: async (id, title) => {
    const { sideChat } = await request<{ sideChat: SideChatDto }>(API_PATHS.sideChat(id), { method: "PATCH", body: JSON.stringify({ title }) });
    get().upsert(sideChat);
  },

  markSeen: (id, seq) => {
    const current = get().sideChats?.find((c) => c.id === id);
    if (!current || seq <= current.seenSeq) return;
    get().upsert({ ...current, seenSeq: seq });
    void request(API_PATHS.sideChatSeen(id), { method: "POST", body: JSON.stringify({ seq }) }).catch(() => {
      // Not written: back to what it was, unless something moved it since.
      const now = get().sideChats?.find((c) => c.id === id);
      if (now && now.seenSeq === seq) get().upsert({ ...now, seenSeq: current.seenSeq });
    });
  },

  summary: async (id, signal) => {
    const { summary } = await request<{ summary: string }>(API_PATHS.sideChatSummary(id), { method: "POST", ...(signal ? { signal } : {}) });
    return summary;
  },

  send: async (id, summary, note) => {
    await request(API_PATHS.sideChatSend(id), { method: "POST", body: JSON.stringify({ summary, note }) });
    get().remove(id);
  },

  discard: async (id) => {
    await request(API_PATHS.sideChat(id), { method: "DELETE" });
    get().remove(id);
  }
}));
