import { useMemo } from "react";
import type { AgentChatScope } from "@/store/agent-chat";
import { usePersonalAgentStore } from "@/store/personal-agent";
import { useManagerThreadsStore } from "@/store/manager-threads";
import type { OpenQuestion } from "@shared/questions";

const NONE: OpenQuestion[] = [];

/** The questions that stand above a conversation's composer: those it asked
 *  itself, a manager thread's or the personal agent's. A question stands
 *  where it was asked: a worker's stays in the worker's own view (its plan),
 *  its tab and Home's list, not over its manager's composer. */
export function useOpenQuestions(scope: AgentChatScope): OpenQuestion[] {
  const threadId = scope.type === "manager" ? scope.threadId : "";
  const thread = useManagerThreadsStore((s) => (threadId ? s.threads.get(threadId) : undefined));
  const agent = usePersonalAgentStore((s) => s.agent);
  return useMemo(() => {
    if (scope.type === "personal") return agent && agent.threadId === scope.threadId ? agent.questions : NONE;
    if (scope.type !== "manager" || !thread) return NONE;
    return thread.questions;
  }, [scope, thread, agent]);
}
