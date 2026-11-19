import type { AgentMessageDto } from "./api/agents.js";
import { isModelOnlySource, type AgentMessageSource } from "./agent-message-types.js";
import { answersOf } from "./questions.js";

/** A message the owner typed themselves: not one their agent sent for them,
 *  a side chat handed over, or an answer picked for a question (deleting
 *  that would leave the question answered by nothing). The server decides
 *  what can be deleted; the page reads the same rule to offer it. */
export function isOwnTypedMessage(message: Pick<AgentMessageDto, "role" | "source" | "content">): boolean {
  if (message.role !== "user" || message.source !== "user" || message.content.type !== "text") return false;
  return !message.content.relay && !message.content.sideChat && answersOf(message.content).length === 0;
}

/** How a row after a message bears on whether the agent answered it. What a
 *  turn reads beside the conversation (its context, a reminder, a summary)
 *  and a line the conversation shows of itself are neither here nor there; a
 *  reply or a tool call is the answer; the line of a turn that failed goes
 *  with the message it failed on; anything else is the next message that came
 *  in, shown in the chat or not. One rule for the server, which decides, and
 *  the page, which offers. */
export type RowAfterMessage = "aside" | "answer" | "failure" | "incoming";

export function rowAfterMessage(row: { role: string; source: string }): RowAfterMessage {
  if (row.source === "compression" || isModelOnlySource(row.source as AgentMessageSource)) return "aside";
  if (row.role === "assistant" || row.role === "tool") return "answer";
  if (row.role === "system") return row.source === "wake-failure" ? "failure" : "aside";
  return "incoming";
}
