import type { AgentClientMessageDto, AgentMessageDto } from "../../../shared/api-contracts.js";

/** Do not mutate persisted messages: the next model call still needs SDK state. */
export function toAgentClientMessage(message: AgentMessageDto): AgentClientMessageDto {
  if (message.content.type !== "assistant") return message;
  const content = { ...message.content };
  delete content.sdkAssistantMessages;
  return { ...message, content };
}
