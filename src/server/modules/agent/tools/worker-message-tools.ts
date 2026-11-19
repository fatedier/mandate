import { z } from "zod";
import type { AgentStore, AgentWakeReason } from "../agent-store.js";
import type { ToolDefinition } from "../tool-registry.js";
import type { WorkersStore } from "../../workers/workers-store.js";
import { workerMessageRequestMetadata } from "../../../../shared/worker-message.js";
import { ownerRefusal } from "../../workers/ownership.js";
import { sendParams } from "./worker-message-tools-schema.js";

interface WorkerMessageToolDeps {
  agentStore: AgentStore;
  workersStore: WorkersStore;
  wakeScheduler: {
    wake: (
      threadId: string,
      reason: AgentWakeReason,
      triggerMessageId: string | null
    ) => string | null;
  };
}

export function buildWorkerMessageSendTool(deps: WorkerMessageToolDeps): ToolDefinition<
  z.infer<typeof sendParams>,
  {
    workerThreadId?: string;
    /** The queued request's id: the wake that reads it is the one answering. */
    requestId?: string;
    status?: "started" | "queued";
    error?: string;
  }
> {
  return {
    name: "message_worker",
    description:
      "Send a message to a worker's main conversation: its work, questions, clarifications, added context, " +
      "feedback, or the next turn of an existing conversation.",
    parameters: sendParams,
    handler: async ({ workerId, message }, ctx) => {
      const worker = deps.workersStore.getById(workerId);
      if (!worker) return { error: `worker not found: ${workerId}` };
      if (worker.archivedAt) return { error: `worker is archived: ${workerId}` };
      const refusal = ownerRefusal(deps, workerId, ctx.threadId);
      if (refusal) return { error: refusal };

      const thread = deps.agentStore.getOrCreateThread("worker", workerId);
      const request = deps.agentStore.enqueueMailboxMessage({
        threadId: thread.id,
        role: "user",
        source: "manager",
        sourceThreadId: ctx.threadId,
        content: {
          type: "text",
          text: message,
          metadata: workerMessageRequestMetadata()
        }
      });

      const wakeId = deps.wakeScheduler.wake(thread.id, "user", null);
      return {
        workerThreadId: thread.id,
        requestId: request.id,
        status: wakeId ? "started" : "queued"
      };
    }
  };
}
