import * as path from "node:path";
import { globalAgentDir } from "../../platform/fs/resources.js";
import type { ConversationScope } from "../../../shared/api/agents.js";
import type { AgentStore } from "../../modules/agent/agent-store.js";
import type { BackgroundTaskStore } from "../../modules/agent/background-task-store.js";
import type { FeaturesStore } from "../../modules/features/features-store.js";
import type { ProjectsStore } from "../../modules/projects/projects-store.js";
import type { AgentScope as AgentToolScope } from "../../modules/agent/tool-scope.js";
import { ToolDispatcher, ToolRegistry, type ToolContext, type ToolDefinition } from "../../modules/agent/tool-registry.js";
import { subagentParentOf, type SubagentParent } from "../../modules/agent/subagent-threads.js";
import { renderPromptFile } from "../../platform/prompts/prompt-template.js";
import type { ScopeRuntime, WrappedDispatcher } from "../scope.js";
import { registerToolPacks, toolPack, type ToolPack } from "../tool-packs.js";
import promptPath from "../../modules/agent/prompts/subagent.md" with { type: "file" };
import pagePromptPath from "../../modules/page/prompts/page-subagent.md" with { type: "file" };
import { pageContract } from "../../modules/page/page-contract.js";

/** A subagent's tools: the working set of the agent that started it — its
 *  files and its shell, and the reads of memory and chat history. Nothing
 *  that watches, waits, asks the user, messages another thread, writes
 *  memory, makes canvases or starts another subagent. */
export const SUBAGENT_TOOLS: ReadonlySet<string> = new Set([
  "read",
  "write",
  "edit",
  "bash",
  "view_image",
  "memory_search",
  "memory_read",
  "chat_history_search",
  "chat_history_read",
  "web_search",
  "web_fetch"
]);

/** The parent's own instances of SUBAGENT_TOOLS, from the packs its scope
 *  registers, so each keeps the parent's deps and the description and
 *  parameters its parent's model reads. One its parent lacks (Your agent has
 *  no view_image) the subagent lacks too. Its `bash`, when given, is its own:
 *  one with no background. */
export function pickSubagentTools(parentScope: ConversationScope, parentToolPacks: readonly ToolPack[], bash?: ToolDefinition): ToolPack {
  const tools = parentToolPacks
    .filter((pack) => pack.scopes.includes(parentScope))
    .flatMap((pack) => pack.tools)
    .filter((tool) => SUBAGENT_TOOLS.has(tool.name))
    .map((tool) => (bash && tool.name === "bash" ? bash : tool));
  return toolPack(`subagent.${parentScope}`, ["subagent"], tools);
}

/** A page subagent's tools: Your agent's files, shell and web, to change its
 *  page and try a source's command. Nothing that reads memory or chat. */
export const PAGE_SUBAGENT_TOOLS: ReadonlySet<string> = new Set(["read", "write", "edit", "bash", "web_search", "web_fetch"]);

/** Your agent's own instances of PAGE_SUBAGENT_TOOLS; its `bash`, when
 *  given, is the subagents' (no background). */
export function pickPageSubagentTools(globalToolPacks: readonly ToolPack[], bash?: ToolDefinition): ToolPack {
  const tools = globalToolPacks
    .filter((pack) => pack.scopes.includes("global"))
    .flatMap((pack) => pack.tools)
    .filter((tool) => PAGE_SUBAGENT_TOOLS.has(tool.name))
    .map((tool) => (bash && tool.name === "bash" ? bash : tool));
  return toolPack("subagent.page", ["subagent"], tools);
}

/** A subagent whose parent is gone runs nothing. Its tool scope fails this
 *  way first (buildToolScope, at each call of a wake): no line for a model. */
const noParent = (threadId: string) => new Error(`no parent thread for subagent thread ${threadId}`);

export interface SubagentScopeDeps {
  agentStore: Pick<AgentStore, "getThreadById">;
  backgroundTasks: Pick<BackgroundTaskStore, "getByChildThread">;
  featuresStore: Pick<FeaturesStore, "getById">;
  projectsStore: Pick<ProjectsStore, "getById">;
  /** Each kind of parent's own tools of SUBAGENT_TOOLS (pickSubagentTools). */
  toolPacks: Record<ConversationScope, ToolPack>;
  /** The tool scope the parent's own scope runtime builds for it: a
   *  subagent reads and writes within its parent's roots, and its shell
   *  starts where its parent's does. */
  parentToolScope: (parent: SubagentParent) => AgentToolScope;
  /** Your agent's page: its folder, and its page subagents' tools
   *  (pickPageSubagentTools). Without it a page subagent runs as a general one. */
  page?: { dir: string; toolPack: ToolPack };
}

/** A subagent's thread: one self-contained job for the conversation that
 *  started it, done with that conversation's tools in that conversation's
 *  scope. Its own thread id stays on every call: what it read before it
 *  edits, and the history handles it holds, are its own. */
export function buildSubagentScope(deps: SubagentScopeDeps): ScopeRuntime {
  const dispatcherOf = (pack: ToolPack): ToolDispatcher => {
    const registry = new ToolRegistry();
    registerToolPacks(registry, "subagent", [pack]);
    return new ToolDispatcher(registry);
  };
  // One set for each kind of parent: the tools the model is offered follow the parent.
  const dispatchers: Record<ConversationScope, ToolDispatcher> = {
    worker: dispatcherOf(deps.toolPacks.worker),
    manager: dispatcherOf(deps.toolPacks.manager),
    global: dispatcherOf(deps.toolPacks.global)
  };

  /** What a call carries besides the wake loop's: a worker parent's feature
   *  and project, as the worker's own calls carry them. Null for a worker
   *  whose feature or project is gone. */
  const parentContext = (parent: SubagentParent): Pick<ToolContext, "feature" | "project"> | null => {
    if (parent.scope !== "worker") return {};
    const feature = parent.scopeId ? deps.featuresStore.getById(parent.scopeId) : null;
    const project = feature ? deps.projectsStore.getById(feature.projectId) : null;
    return feature && project ? { feature, project } : null;
  };

  const forParentScope = (scope: ConversationScope): WrappedDispatcher => ({
    registry: { get tools() { return dispatchers[scope].registry.tools; } },
    dispatch: async (call, ctx) => {
      const parent = subagentParentOf(deps, ctx.threadId);
      if (!parent) throw noParent(ctx.threadId);
      const context = parentContext(parent);
      // As the worker's own tool scope fails, which comes first.
      if (!context) throw new Error(`feature or project missing for the worker of subagent thread ${ctx.threadId}`);
      return dispatchers[scope].dispatch(call, { ...ctx, ...context });
    }
  });
  const byParentScope: Record<ConversationScope, WrappedDispatcher> = {
    worker: forParentScope("worker"),
    manager: forParentScope("manager"),
    global: forParentScope("global")
  };
  // A page subagent's: Your agent is its parent, whose calls carry nothing more.
  const pageDispatcher = deps.page ? dispatcherOf(deps.page.toolPack) : null;
  const forPage: WrappedDispatcher | null = pageDispatcher ? {
    registry: { get tools() { return pageDispatcher.registry.tools; } },
    dispatch: async (call, ctx) => {
      if (!subagentParentOf(deps, ctx.threadId)) throw noParent(ctx.threadId);
      return pageDispatcher.dispatch(call, ctx);
    }
  } : null;
  const isPage = (threadId: string) => deps.backgroundTasks.getByChildThread(threadId)?.type === "page";
  /** A subagent whose task or parent is gone: offered nothing, and nothing it asks for runs. */
  const orphaned: WrappedDispatcher = {
    registry: { tools: {} },
    dispatch: async (_call, ctx) => { throw noParent(ctx.threadId); }
  };

  return {
    scope: "subagent",

    verifyScopeId() {
      return "a subagent's thread is read by its id";
    },

    buildSystemPrompt(threadId) {
      if (deps.page && isPage(threadId)) {
        // Your agent's notes, where Your agent itself reads them.
        const notesDir = path.join(globalAgentDir(), "notes");
        return renderPromptFile(pagePromptPath, { pageDir: deps.page.dir, notesDir, contract: pageContract() }).trim();
      }
      return renderPromptFile(promptPath, {}).trim();
    },

    buildToolScope(threadId) {
      const parent = subagentParentOf(deps, threadId);
      if (!parent) throw noParent(threadId);
      return deps.parentToolScope(parent);
    },

    dispatcherForThread(threadId) {
      const parent = subagentParentOf(deps, threadId);
      if (!parent) return orphaned;
      return forPage && isPage(threadId) ? forPage : byParentScope[parent.scope];
    },

    wrappedDispatcher: orphaned,
    toolDefinitions: []
  };
}
