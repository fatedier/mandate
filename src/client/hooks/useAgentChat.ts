import { useCallback, useEffect } from "react";
import {
  useAgentChatStore, scopeKey, type AgentChatScope, type ThreadState
} from "@/store/agent-chat";
import type { AgentMessageAttachment } from "@shared/agent-message-types";

export function useAgentChat(scope: AgentChatScope | null): {
  thread: ThreadState | null;
  send: (
    content: string,
    attachments?: AgentMessageAttachment[],
    workItemRef?: { itemId: string; snapshotAt: string }
  ) => Promise<void>;
  retry: (localId: string) => Promise<void>;
  deleteQueued: (localId: string) => Promise<void>;
  loadOlder: () => Promise<void>;
} {
  const ensureThreadLoaded = useAgentChatStore((s) => s.ensureThreadLoaded);
  const sendMessage = useAgentChatStore((s) => s.sendMessage);
  const retryFailedMessage = useAgentChatStore((s) => s.retryFailedMessage);
  const deleteQueuedMessage = useAgentChatStore((s) => s.deleteQueuedMessage);
  const loadOlder = useAgentChatStore((s) => s.loadOlder);
  const key = scope ? scopeKey(scope) : null;
  const thread = useAgentChatStore((s) =>
    key ? s.threadsByScope.get(key) ?? null : null
  );

  useEffect(() => {
    if (!scope) return;
    void ensureThreadLoaded(scope);
  }, [key, scope, ensureThreadLoaded]);

  const send = useCallback(
    async (
      content: string,
      attachments?: AgentMessageAttachment[],
      workItemRef?: { itemId: string; snapshotAt: string }
    ) => {
      // Drawer UIs read send status from the pending message entries, so the
      // terminal status sendMessage resolves with is intentionally discarded.
      if (scope) await sendMessage(scope, content, attachments, workItemRef);
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
    () => scope ? loadOlder(scope) : Promise.resolve(),
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
