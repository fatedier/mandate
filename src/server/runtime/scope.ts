import type { AgentScope } from "../modules/agent/agent-store.js";
import type { ToolSet } from "ai";
import type { AgentScope as AgentToolScope } from "../modules/agent/tool-scope.js";
import type { RegisteredToolDefinition, ToolContext } from "../modules/agent/tool-registry.js";

/** What the WakeScheduler hands tool dispatchers — looks like a tiny ToolDispatcher
 *  but each scope wraps the real one to inject scope-specific ctx (e.g. the feature
 *  scope adds `feature`/`project`/`tmuxClient`/`analyzer`). */
export interface WrappedDispatcher {
  registry: { tools: ToolSet };
  dispatch(
    call: { toolCallId: string; toolName: string; args: unknown },
    ctx: ToolContext
  ): Promise<{ result?: unknown; isError?: boolean; error?: string }>;
}

/** Per-scope (feature / overview / future …) bundle of everything the agent
 *  runtime needs in order to talk to threads of that scope. Adding a new scope
 *  is "drop a new file under runtime/scopes/ that returns a ScopeRuntime."
 *
 *  Cross-cutting orchestration (WakeScheduler, bridges, the HTTP routes that
 *  look up the right ScopeRuntime by scope name) lives outside. */
export interface ScopeRuntime {
  scope: AgentScope;
  /** HTTP-route gate. Returns null if `scopeId` is acceptable for this scope,
   *  or an error string the route should return as a 404 body. Feature scope
   *  rejects unknown / archived feature ids; overview scope rejects non-null
   *  scope ids. */
  verifyScopeId(scopeId: string | null): string | null;
  /** Build the immutable initial system prompt for a thread in this scope.
   *  The wake loop stores the first generated value as the thread's system
   *  message and reuses it; do not include live runtime state here. */
  buildSystemPrompt(threadId: string): Promise<string> | string;
  /** Build context that should appear once at the active prompt baseline
   *  (thread start, or after compression removes the old baseline). This is
   *  the right place for capability manifests such as skills that should not
   *  repeat every step but may need to refresh after compaction. */
  buildInitialContext?(threadId: string): Promise<string | null> | string | null;
  /** Build an append-only user-role runtime context snapshot. This may
   *  include live project/feature/pane/task/memory state and is appended only
   *  when the rendered content changes. */
  buildRuntimeContext?(threadId: string): Promise<string | null> | string | null;
  /** Build the per-call tool scope object the wake-loop attaches to ctx. */
  buildToolScope(threadId: string): AgentToolScope;
  /** Tools registry + ctx-injecting dispatcher for this scope. */
  wrappedDispatcher: WrappedDispatcher;
  /** The raw ToolDefinitions backing the wrappedDispatcher's registry — exposed
   *  so non-wake-loop consumers (voice agent) can read parameters / handlers. */
  toolDefinitions: RegisteredToolDefinition[];
}
