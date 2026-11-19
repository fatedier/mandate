import type { WaitingEntryDto } from "../../../shared/api/thread-status.js";
import { AGENT_QUESTION_MATTER } from "../../../shared/api/notifications.js";

/** The safety net's matters for the personal agent's own entries. */
export const AGENT_QUESTION_KEY = AGENT_QUESTION_MATTER;
export const AGENT_HELD_KEY = "agent:held";

/** The personal agent's own question (its entry names no thread). */
export function isAgentQuestion(entry: WaitingEntryDto): boolean {
  return entry.kind === "agent" && entry.threadId === null;
}

/** The personal agent's calls held back by the tool-call review (named by its thread). */
export function isAgentHeld(entry: WaitingEntryDto): boolean {
  return entry.kind === "agent" && entry.threadId !== null;
}

/** Whether "Waiting on you" lists the matter: what the New thread page shows. */
export function listsMatter(entries: readonly WaitingEntryDto[], key: string): boolean {
  if (key === AGENT_QUESTION_KEY) return entries.some(isAgentQuestion);
  if (key === AGENT_HELD_KEY) return entries.some(isAgentHeld);
  if (key.startsWith("thread:")) {
    const id = key.slice("thread:".length);
    return entries.some((entry) => entry.kind !== "agent" && entry.threadId === id);
  }
  if (key.startsWith("worker:")) {
    const id = key.slice("worker:".length);
    return entries.some((entry) => entry.workerId === id);
  }
  return false;
}
