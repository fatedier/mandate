import type { AgentClientMessageDto, AgentMessageDto } from "../../../shared/api-contracts.js";
import { withImageAddresses } from "./message-images.js";

/** Do not mutate persisted messages: the next model call still needs SDK state. */
export function toAgentClientMessage(message: AgentMessageDto): AgentClientMessageDto {
  if (message.content.type !== "assistant") return { ...message, content: withImageAddresses(message.id, message.content) };
  const content = { ...message.content };
  delete content.sdkAssistantMessages;
  // Kept for later, not shown: the page hears only the live heading.
  delete content.reasoning;
  return { ...message, content };
}
