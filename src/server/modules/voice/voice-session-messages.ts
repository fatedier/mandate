import { SSE_EVENTS } from "../../../shared/api-contracts.js";
import type { AgentMessage, AgentStore } from "../agent/agent-store.js";
import type { AgentSseEmitter } from "../sse/sse-events.js";
import { isModelOnlySource, isPageNoteSource } from "../../../shared/agent-message-types.js";

/** A row as dialogue for the voice conversation, or null: rows only the
 *  model reads (runtime context and the like, notes about Your agent's
 *  page) are never dialogue. */
export function voiceDialogueItem(message: AgentMessage): { role: "user" | "assistant"; text: string } | null {
  if (isModelOnlySource(message.source) || isPageNoteSource(message.source)) return null;
  if (message.role === "user" && message.content.type === "text") {
    const text = message.content.text?.trim();
    return text ? { role: "user", text } : null;
  }
  if (message.role === "assistant" && message.content.type === "assistant") {
    const text = message.content.text?.trim();
    return text ? { role: "assistant", text } : null;
  }
  return null;
}

/** The thread's spoken and typed dialogue, newest last. */
export function collectVoicePreloadItems(
  agentStore: AgentStore,
  threadId: string,
  n: number
): { role: "user" | "assistant"; text: string }[] {
  return agentStore.getMessages(threadId).flatMap((message) => voiceDialogueItem(message) ?? []).slice(-n);
}

export function persistVoiceTranscript(input: {
  agentStore: AgentStore;
  sse: AgentSseEmitter;
  threadId: string;
  speaker: "user" | "assistant";
  text: string;
  /** An assistant line that told the user a Mandate update. */
  spokenUpdate?: boolean;
}): void {
  const content = input.speaker === "user"
    ? {
        type: "text" as const,
        text: input.text
      }
    : { type: "assistant" as const, text: input.text, toolCalls: [], ...(input.spokenUpdate ? { spokenUpdate: true } : {}) };
  const message = input.agentStore.appendMessage({
    threadId: input.threadId,
    role: input.speaker,
    source: "voice",
    content
  });
  input.sse.emit(SSE_EVENTS.agentMessageAppended, { threadId: input.threadId, message });
}

export function persistVoiceToolUse(input: {
  agentStore: AgentStore;
  sse: AgentSseEmitter;
  threadId: string;
  callId: string;
  name: string;
  args: unknown;
}): void {
  const message = input.agentStore.appendMessage({
    threadId: input.threadId,
    role: "assistant",
    source: "voice",
    content: {
      type: "assistant",
      toolCalls: [{ toolCallId: input.callId, toolName: input.name, args: input.args }]
    }
  });
  input.sse.emit(SSE_EVENTS.agentMessageAppended, { threadId: input.threadId, message });
}

export function persistVoiceToolResult(input: {
  agentStore: AgentStore;
  sse: AgentSseEmitter;
  threadId: string;
  callId: string;
  name: string;
  payload: { result?: unknown; errorMessage?: string };
}): void {
  const message = input.agentStore.appendMessage({
    threadId: input.threadId,
    role: "tool",
    source: "voice",
    content: {
      type: "tool_result",
      toolCallId: input.callId,
      toolName: input.name,
      ...(input.payload.errorMessage !== undefined
        ? { isError: true, error: input.payload.errorMessage }
        : { result: input.payload.result })
    }
  });
  input.sse.emit(SSE_EVENTS.agentMessageAppended, { threadId: input.threadId, message });
}
