import type { AgentMessage } from "@/store/agent-chat-types";

/** The call a running wake is on: its first call with no result yet. The
 *  server writes a step's calls before it runs any and then runs them one at a
 *  time, so no event is needed to know which one is under way. */
export function runningToolCallId(
  messages: readonly AgentMessage[],
  wakeId: string | null,
  answered: (toolCallId: string) => boolean
): string | null {
  if (!wakeId) return null;
  for (const message of messages) {
    if (message.wakeId !== wakeId || message.content.type !== "assistant") continue;
    for (const call of message.content.toolCalls ?? []) {
      if (!answered(call.toolCallId)) return call.toolCallId;
    }
  }
  return null;
}
