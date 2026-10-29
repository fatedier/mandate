import type { Config } from "../config.js";
import { chatModelChoices, listedChatModelRef } from "../config/model-resolution.js";
import type { AgentStore } from "../modules/agent/agent-store.js";
import type { AgentSseEmitter } from "../modules/sse/sse-events.js";
import { SSE_EVENTS } from "../../shared/api-contracts.js";
import type { ModelRefDto, ThreadModelDto } from "../../shared/api/agents.js";

interface ThreadModelsDeps {
  config: () => Config;
  agentStore: Pick<AgentStore, "getThreadById" | "setThreadModelOverride">;
  router: {
    /** What the thread's route runs on first. */
    routeModelRefFor(threadId: string): string;
    /** The thread's pick as it runs now (null: none, or one Settings no longer lists). */
    pickFor(threadId: string): string | null;
  };
  sse?: Pick<AgentSseEmitter, "emit">;
}

export type SetThreadModelResult =
  | { ok: true; state: ThreadModelDto }
  | { ok: false; status: 400 | 404; error: string };

/** `provider/model` and its parts: the provider is what comes before the
 *  first slash (a model id may hold slashes of its own). */
function modelRef(ref: string): ModelRefDto {
  const slash = ref.indexOf("/");
  return slash < 0 ? { ref, providerName: "", model: ref } : { ref, providerName: ref.slice(0, slash), model: ref.slice(slash + 1) };
}

/** A thread's model as its composer shows and sets it: Default (its route's
 *  first model) or a chat model Settings lists, stored on the thread. */
export function createThreadModels(deps: ThreadModelsDeps) {
  const state = (threadId: string): ThreadModelDto | null => {
    if (!deps.agentStore.getThreadById(threadId)) return null;
    const pick = deps.router.pickFor(threadId);
    return {
      default: modelRef(deps.router.routeModelRefFor(threadId)),
      override: pick ? modelRef(pick) : null,
      choices: chatModelChoices(deps.config()).map((group) => ({
        providerName: group.providerName,
        models: group.models.map((model) => modelRef(`${group.providerName}/${model}`))
      }))
    };
  };

  return {
    state,
    /** Switches the thread to `ref`, or back to Default with null. */
    set(threadId: string, ref: string | null): SetThreadModelResult {
      const thread = deps.agentStore.getThreadById(threadId);
      if (!thread) return { ok: false, status: 404, error: "thread not found" };
      if (thread.scope === "subagent") return { ok: false, status: 400, error: "A subagent runs on the model of the agent that started it." };
      // Stored as Settings names it, so it is the same model as the route's.
      const listed = ref === null ? null : listedChatModelRef(deps.config(), ref);
      if (ref !== null && listed === null) return { ok: false, status: 400, error: `Not a chat model in Settings: ${ref}` };
      deps.agentStore.setThreadModelOverride(threadId, listed);
      deps.sse?.emit(SSE_EVENTS.agentThreadModelChanged, { threadId });
      return { ok: true, state: state(threadId)! };
    }
  };
}

export type ThreadModels = ReturnType<typeof createThreadModels>;
