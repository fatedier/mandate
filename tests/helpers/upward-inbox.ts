import { createUpwardInbox } from "../../src/server/modules/agent/upward-inbox.js";
import type { AgentStore } from "../../src/server/modules/agent/agent-store.js";
import type { AgentSseEmitter } from "../../src/server/modules/sse/sse-events.js";
import { mailboxWakeReason } from "../../src/server/runtime/mailbox-wake-reason.js";
import type { AgentWakeReason } from "../../src/shared/api/agents.js";

/** A real inbox over `agentStore` whose wakes are recorded, under the reason
 *  the runtime gives them, instead of run. A busy receiver starts none, as
 *  the scheduler starts none: its mail waits for its next step. */
export function recordingInbox(
  agentStore: Pick<AgentStore, "enqueueMailboxMessage" | "appendMessage">,
  options: { busy?: (threadId: string) => boolean } = {}
) {
  const busy = options.busy ?? (() => false);
  const wakes: Array<{ threadId: string; reason: AgentWakeReason }> = [];
  const emitted: Array<{ event: string; data: unknown }> = [];
  const sse = { emit: (event: string, data: unknown) => { emitted.push({ event, data }); } } as unknown as Pick<AgentSseEmitter, "emit">;
  const inbox = createUpwardInbox({
    agentStore,
    sse,
    busy,
    wake: (threadId, source) => { if (!busy(threadId)) wakes.push({ threadId, reason: mailboxWakeReason([source]) }); }
  });
  return { inbox, wakes, emitted };
}
