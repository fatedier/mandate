import type { AgentMessage } from "../agent-store.js";
import { SEAL_PLACEHOLDER_RESULT } from "./seal-request.js";

/**
 * The history with a placeholder result for each tool call of the latest
 * reply that has none stored yet (its tool still runs). Built only for a
 * seal, never stored: the message adapter keeps a reply whole only when every
 * call has a result, and the next step (with the real results) sends it
 * whole, so the seal must too. The placeholders come after the reply, past
 * the seal's mark.
 */
export function withPendingToolResults(messages: readonly AgentMessage[]): AgentMessage[] {
  const reply = messages.findLast((message) => message.role === "assistant");
  if (!reply || reply.content.type !== "assistant" || !reply.content.toolCalls?.length) return [...messages];
  const answered = new Set(messages.flatMap((m) => (m.role === "tool" && m.content.type === "tool_result" ? [m.content.toolCallId] : [])));
  const pending = reply.content.toolCalls.filter((call) => !answered.has(call.toolCallId));
  return [
    ...messages,
    ...pending.map((call): AgentMessage => ({
      id: `${reply.id}:pending:${call.toolCallId}`,
      threadId: reply.threadId,
      seq: reply.seq,
      role: "tool",
      source: "self",
      sourceThreadId: null,
      wakeId: reply.wakeId,
      content: { type: "tool_result", toolCallId: call.toolCallId, toolName: call.toolName, result: SEAL_PLACEHOLDER_RESULT },
      createdAt: reply.createdAt
    }))
  ];
}
