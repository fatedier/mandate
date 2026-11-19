import type { AgentMessage, AgentStore } from "../../src/server/modules/agent/agent-store.js";

/** Every message of a thread, oldest first: what a test inspects after the
 *  fact. The server has no such read; it walks back from the newest message
 *  only as far as it needs (AgentStore.forEachNewestFirst). */
export function allMessages(agentStore: Pick<AgentStore, "getMessagesSince">, threadId: string): AgentMessage[] {
  return agentStore.getMessagesSince(threadId, Number.MIN_SAFE_INTEGER);
}
