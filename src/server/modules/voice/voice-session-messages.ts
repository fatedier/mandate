import type { UiLocation } from "../../../shared/ui-context.js";
import { SSE_EVENTS } from "../../../shared/api-contracts.js";
import { renderPromptFile } from "../../platform/prompts/prompt-template.js";
import type { AgentStore } from "../agent/agent-store.js";
import type { AgentSseEmitter } from "../sse/sse-events.js";
import workerDispatchFollowupPromptPath from "./prompts/worker-dispatch-followup.md" with { type: "file" };

export function collectVoicePreloadItems(
  agentStore: AgentStore,
  threadId: string,
  n: number
): { role: "user" | "assistant"; text: string }[] {
  const all = agentStore.getMessages(threadId);
  const dialogue: { role: "user" | "assistant"; text: string }[] = [];
  for (const message of all) {
    if (message.role === "user" && message.content.type === "text") {
      const text = message.content.text?.trim();
      if (text) dialogue.push({ role: "user", text });
    } else if (message.role === "assistant" && message.content.type === "assistant") {
      const text = message.content.text?.trim();
      if (text) dialogue.push({ role: "assistant", text });
    }
  }
  return dialogue.slice(-n);
}

export function persistVoiceTranscript(input: {
  agentStore: AgentStore;
  sse: AgentSseEmitter;
  threadId: string;
  speaker: "user" | "assistant";
  text: string;
  uiLocation: UiLocation | null;
}): void {
  const content = input.speaker === "user"
    ? {
        type: "text" as const,
        text: input.text,
        ...(input.uiLocation
          ? { clientId: input.uiLocation.clientId, uiLocation: input.uiLocation }
          : {})
      }
    : { type: "assistant" as const, text: input.text, toolCalls: [] };
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

export function extractAssistantText(
  messages: ReturnType<AgentStore["getActiveMessages"]>,
  wakeId: string
): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    if (
      message.wakeId === wakeId
      && message.role === "assistant"
      && message.content.type === "assistant"
    ) {
      return message.content.text ?? "";
    }
  }
  return "";
}

export function formatFeatureDispatchFollowup(input: {
  toolName: string;
  sessionId: string;
  status: "ok" | "error";
  text: string;
}): string {
  return renderPromptFile(workerDispatchFollowupPromptPath, {
    toolName: input.toolName,
    sessionId: input.sessionId,
    status: input.status,
    result: input.text || "(the worker finished with no text response)"
  });
}
