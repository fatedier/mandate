import { useMemo } from "react";
import { ChatMessageList } from "@/routes/window/chat/ChatMessageList";
import { useAgentChat } from "@/hooks/useAgentChat";
import { useOpenQuestions } from "@/hooks/useOpenQuestions";
import { useAgentPageUi } from "@/store/agent-page-ui";

/** The personal agent's conversation beside its chat, to read while chatting: the
 *  chat's own rows, read only, with a place of its own. A send in the chat,
 *  a new reply or another tab shown leaves it where the reader left it. */
export function HistoryTab({ threadId }: { threadId: string }) {
  const scope = useMemo(() => ({ type: "personal" as const, threadId }), [threadId]);
  const { thread, loadOlder } = useAgentChat(scope);
  const opened = useAgentPageUi((s) => s.historyOpened);
  // Read where it was when shown: it reports its place as it is read.
  const startAt = useAgentPageUi.getState().historyPlace;
  // Its questions read as the chat's do: open while they are.
  const questions = useOpenQuestions(scope);
  const openQuestionIds = useMemo(() => new Set(questions.map((question) => question.id)), [questions]);
  if (!thread) return null;
  return (
    <div data-slot="history-tab" className="flex min-h-0 flex-1 flex-col">
      <ChatMessageList
        key={opened}
        thread={thread}
        view="history"
        startAt={startAt}
        onPlace={(place) => useAgentPageUi.getState().setHistoryPlace(place)}
        openQuestionIds={openQuestionIds}
        onLoadOlder={loadOlder}
      />
    </div>
  );
}
