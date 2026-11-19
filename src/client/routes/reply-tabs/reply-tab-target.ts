import { createContext, useContext } from "react";
import { useReplyTabsStore } from "@/store/reply-tabs";

/** Where a reply opened in the panel goes: the thread whose chat this is, and
 *  how its page opens a tab (beside the chat on a desktop; the panel or
 *  the panel sheet on a phone). Provided by Personal agent's page and a thread's
 *  page around their own chat; a chat elsewhere (a worker's, in the panel)
 *  has none, and its replies get no button. */
export interface ReplyTabTarget {
  threadId: string;
  open(tabId: string): void;
}

export const ReplyTabTargetContext = createContext<ReplyTabTarget | null>(null);

/** Whether this chat's reply has its tab in the panel: its action line then
 *  stays in sight, as the latest reply's does. */
export function useReplyHasTab(messageId: string | null): boolean {
  const threadId = useContext(ReplyTabTargetContext)?.threadId ?? null;
  return useReplyTabsStore((s) => messageId !== null && threadId !== null && (s.byThread.get(threadId) ?? []).some((t) => t.messageId === messageId));
}
