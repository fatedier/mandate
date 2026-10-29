import { useMemo } from "react";
import { useThreadWorkers } from "@/hooks/useThreadWorkers";
import { shownQuestions, type ShownQuestion } from "@/lib/shown-questions";
import type { AgentChatScope } from "@/store/agent-chat";
import { useFeaturePlansStore } from "@/store/feature-plans";
import { useGlobalAgentStore } from "@/store/global-agent";
import { useManagerThreadsStore } from "@/store/manager-threads";
import { useThreadStatusStore } from "@/store/thread-status";

const NONE: ShownQuestion[] = [];

/** The questions that stand above a conversation's composer (shownQuestions):
 *  a manager thread's own and its workers' that the server lists as the
 *  user's; the global agent's own. A worker's chat has none of this kind: its question is shown
 *  in its own view. */
export function useOpenQuestions(scope: AgentChatScope): ShownQuestion[] {
  const threadId = scope.type === "manager" ? scope.threadId : "";
  const thread = useManagerThreadsStore((s) => (threadId ? s.threads.get(threadId) : undefined));
  const workers = useThreadWorkers(threadId);
  const plans = useFeaturePlansStore((s) => s.plans);
  const waiting = useThreadStatusStore((s) => s.waiting);
  const agent = useGlobalAgentStore((s) => s.agent);
  return useMemo(() => {
    if (scope.type === "global") return agent && agent.threadId === scope.threadId ? shownQuestions({ questions: agent.questions }) : NONE;
    if (scope.type !== "manager" || !thread) return NONE;
    // The workers whose question the server lists as the user's, in this thread.
    const askingWorkers = new Set(waiting
      .filter((entry) => entry.kind === "worker" && entry.waiting === "input" && entry.threadId === thread.id && entry.featureId)
      .map((entry) => entry.featureId!));
    return shownQuestions({ questions: thread.questions, workers, plans, askingWorkers });
  }, [scope, thread, workers, plans, waiting, agent]);
}
