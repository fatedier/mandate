import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { ToolDefinition } from "../agent/tool-registry.js";
import type { AgentStore } from "../agent/agent-store.js";
import type { WorkersStore } from "../workers/workers-store.js";
import { errorText } from "../../../shared/error-text.js";
import type { MatterRef, NotificationService } from "./notification-service.js";
import { params } from "./notify-tool-schema.js";

function given(value: string | null | undefined): string | undefined {
  return value?.trim() ? value.trim() : undefined;
}

/** The personal agent's own: tells the user something outside its conversation. The
 *  service decides where and when; the agent hears what happened. */
export function buildNotifyTool(deps: {
  service: Pick<NotificationService, "notify">;
  agentStore: Pick<AgentStore, "getThreadById">;
  workersStore: Pick<WorkersStore, "getById">;
}): ToolDefinition<z.infer<typeof params>, unknown> {
  const matterOf = (threadId: string | undefined, workerId: string | undefined): MatterRef => {
    if (threadId && workerId) throw new Error("Give at most one of threadId and workerId.");
    if (threadId) {
      const thread = deps.agentStore.getThreadById(threadId);
      if (!thread || thread.archivedAt) throw new Error(`No open thread ${threadId}.`);
      return { key: `thread:${threadId}`, link: `/threads/${encodeURIComponent(threadId)}` };
    }
    if (workerId) {
      const worker = deps.workersStore.getById(workerId);
      if (!worker) throw new Error(`No worker ${workerId}.`);
      const owner = worker.ownerThreadId;
      return { key: `worker:${workerId}`, link: owner ? `/threads/${encodeURIComponent(owner)}?worker=${encodeURIComponent(workerId)}` : "/home" };
    }
    // Its own matter: each call one of its own.
    return { key: `agent:${randomUUID()}`, link: "/agent" };
  };
  return {
    name: "notify",
    description: "Tell the user something now, outside this conversation, on the channels they set up (a desktop notification, their phone). Unless you name channels, Mandate chooses from where the user is right now: nothing while they are already looking at it, their computer while they are at it, their phone when they are away or leave it unseen for a few minutes. On the computer, another call about the same thread or worker replaces the earlier notice; on the phone, each call is a new message.",
    parameters: params,
    handler: async (args) => {
      let matter: MatterRef;
      try {
        matter = matterOf(given(args.threadId), given(args.workerId));
      } catch (err) {
        return { error: errorText(err) };
      }
      // A blank list, or blank names, is the model filling the field: Mandate's choice.
      const channels = (args.channels ?? []).map((name) => name.trim()).filter(Boolean);
      const outcome = await deps.service.notify({
        source: "agent", matter, title: args.title, text: args.text, level: args.level ?? "needs_you",
        ...(channels.length > 0 ? { channels } : {})
      });
      // A channel it cannot name fails the call, as a thread it cannot name does.
      return outcome.notSent === "channel" ? { error: outcome.line } : { outcome: outcome.line };
    }
  };
}
