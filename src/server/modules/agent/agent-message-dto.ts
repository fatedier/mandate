import type { AgentClientMessageDto, AgentMessageDto } from "../../../shared/api-contracts.js";
import type { DutyReportOutcome } from "../../../shared/api/schedules.js";
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

/** What became of a duty thread's replies, read for a page of messages:
 *  each recorded one carries its outcome. Without a reader, the page as is. */
export function withDutyMarks<M extends { id: string; dutyReport?: DutyReportOutcome }>(
  messages: M[],
  marksFor: ((ids: string[]) => ReadonlyMap<string, DutyReportOutcome>) | undefined
): M[] {
  if (!marksFor || messages.length === 0) return messages;
  const marks = marksFor(messages.map((m) => m.id));
  if (marks.size === 0) return messages;
  return messages.map((m) => {
    const mark = marks.get(m.id);
    return mark ? { ...m, dutyReport: mark } : m;
  });
}
