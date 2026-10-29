import { useCallback } from "react";
import {
  useAgentChatStore, scopeKey, type ChatThreadScope, type ThreadState
} from "@/store/agent-chat";
import type { AgentMessageAttachment } from "@shared/agent-message-types";
import type { Mention } from "@shared/mentions";

/** One conversation — main or side — and the actions on it. Loading it is
 *  the caller's: ChatConversation shows the load's failure. */
export function useAgentChat(scope: ChatThreadScope | null): {
  thread: ThreadState | null;
  send: (
    content: string,
    attachments?: AgentMessageAttachment[],
    mentions?: Mention[]
  ) => Promise<void>;
  retry: (localId: string) => Promise<void>;
  deleteQueued: (localId: string) => Promise<void>;
  loadOlder: (apply?: (write: () => void) => void) => Promise<void>;
} {
  const sendMessage = useAgentChatStore((s) => s.sendMessage);
  const retryFailedMessage = useAgentChatStore((s) => s.retryFailedMessage);
  const deleteQueuedMessage = useAgentChatStore((s) => s.deleteQueuedMessage);
  const loadOlder = useAgentChatStore((s) => s.loadOlder);
  const key = scope ? scopeKey(scope) : null;
  const thread = useAgentChatStore((s) =>
    key ? s.threadsByScope.get(key) ?? null : null
  );

  const send = useCallback(
    async (
      content: string,
      attachments?: AgentMessageAttachment[],
      mentions?: Mention[]
    ) => {
      // Drawer UIs read send status from the pending message entries, so the
      // terminal status sendMessage resolves with is intentionally discarded.
      if (scope) await sendMessage(scope, content, attachments, mentions);
    },
    [scope, sendMessage]
  );
  const retry = useCallback(
    (localId: string) => scope ? retryFailedMessage(scope, localId) : Promise.resolve(),
    [scope, retryFailedMessage]
  );
  const deleteQueued = useCallback(
    (localId: string) => scope ? deleteQueuedMessage(scope, localId) : Promise.resolve(),
    [scope, deleteQueuedMessage]
  );
  const loadOlderForScope = useCallback(
    (apply?: (write: () => void) => void) => scope ? loadOlder(scope, apply) : Promise.resolve(),
    [scope, loadOlder]
  );

  return {
    thread,
    send,
    retry,
    deleteQueued,
    loadOlder: loadOlderForScope
  };
}
