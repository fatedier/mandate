import { expect, test } from "bun:test";
import { ToolDispatcher, ToolRegistry } from "../src/server/modules/agent/tool-registry.js";
import { buildMemoryTools } from "../src/server/modules/memory/tools/memory.js";
import { LocalMemoryProvider } from "../src/server/modules/memory/local-provider.js";
import { MemoryManager } from "../src/server/modules/memory/manager.js";
import { freshStoresEnv } from "./helpers/fixtures.js";

function registerMemoryTools(registry: ToolRegistry, memory: MemoryManager, scope: "manager" | "worker") {
  for (const tool of buildMemoryTools(memory, scope)) registry.register(tool);
}

test("memory tools: remember defaults to current feature context", async () => {
  const env = freshStoresEnv("md-memory-tool-");
  try {
    const manager = new MemoryManager(new LocalMemoryProvider(env.store.db));
    const registry = new ToolRegistry();
    registerMemoryTools(registry, manager, "worker");
    expect(registry.getDefinition("memory_archive")).toBeNull();
    expect(registry.getDefinition("memory_search")!.parameters.safeParse({
      query: "tmux-pane",
      projectId: "project-1"
    }).success).toBe(false);
    expect(registry.getDefinition("memory_remember")!.parameters.safeParse({
      content: "Use the tmux-pane skill before terminal actions.",
      projectId: "project-1"
    }).success).toBe(false);
    const dispatcher = new ToolDispatcher(registry);

    const result = await dispatcher.dispatch({
      toolCallId: "c1",
      toolName: "memory_remember",
      args: {
        content: "Use the tmux-pane skill before terminal actions.",
        kind: "preference",
        source: "explicit_user"
      }
    }, {
      threadId: "thread-1",
      wakeId: "wake-1",
      scope: { kind: "worker", feature: { workingDir: "/repo" }, project: { workingDir: "/repo" } },
      project: {
        id: "project-1",
        name: "P",
        workingDir: "/repo",
        isGit: false,
        gitRemote: null,
        tmuxSessionName: "md-p",
        ownership: "app",
        createdAt: "",
        updatedAt: "",
        archivedAt: null
      },
      feature: {
        id: "feature-1",
        projectId: "project-1",
        name: "F",
        mode: "shared-cwd",
        branch: null,
        worktreePath: "/repo",
        tmuxWindowName: "f",
        ownership: "app",
        createdAt: "",
        updatedAt: "",
        archivedAt: null
      }
    });

    expect(result.isError).toBeFalsy();
    const memory = (result.result as any).memory;
    expect(memory.scope).toBe("feature");
    expect(memory.projectId).toBe("project-1");
    expect(memory.featureId).toBe("feature-1");
    expect(memory.metadata).toBeUndefined();
    expect(memory.sourceThreadId).toBeUndefined();
    expect(memory.feedback).toBeUndefined();

    const search = await dispatcher.dispatch({
      toolCallId: "c2",
      toolName: "memory_search",
      args: { query: "tmux-pane", maxResults: 5 }
    }, {
      threadId: "thread-1",
      wakeId: "wake-1",
      scope: { kind: "worker", feature: { workingDir: "/repo" }, project: { workingDir: "/repo" } },
      project: {
        id: "project-1",
        name: "P",
        workingDir: "/repo",
        isGit: false,
        gitRemote: null,
        tmuxSessionName: "md-p",
        ownership: "app",
        createdAt: "",
        updatedAt: "",
        archivedAt: null
      },
      feature: {
        id: "feature-1",
        projectId: "project-1",
        name: "F",
        mode: "shared-cwd",
        branch: null,
        worktreePath: "/repo",
        tmuxWindowName: "f",
        ownership: "app",
        createdAt: "",
        updatedAt: "",
        archivedAt: null
      }
    });
    expect(search.isError).toBeFalsy();
    expect((search.result as any).memories[0].content).toContain("tmux-pane");
    expect((search.result as any).memories[0].id).toBe(memory.id);
    expect((search.result as any).memories[0].scope).toBe("feature");
    expect((search.result as any).memories[0].kind).toBe("preference");
    expect((search.result as any).memories[0].metadata).toBeUndefined();
    expect((search.result as any).memories[0].sourceThreadId).toBeUndefined();

    const feedback = await dispatcher.dispatch({
      toolCallId: "c3",
      toolName: "memory_feedback",
      args: {
        id: memory.id,
        outcome: "used",
        note: "relied on for terminal action"
      }
    }, {
      threadId: "thread-1",
      wakeId: "wake-1",
      scope: { kind: "worker", feature: { workingDir: "/repo" }, project: { workingDir: "/repo" } },
      project: {
        id: "project-1",
        name: "P",
        workingDir: "/repo",
        isGit: false,
        gitRemote: null,
        tmuxSessionName: "md-p",
        ownership: "app",
        createdAt: "",
        updatedAt: "",
        archivedAt: null
      },
      feature: {
        id: "feature-1",
        projectId: "project-1",
        name: "F",
        mode: "shared-cwd",
        branch: null,
        worktreePath: "/repo",
        tmuxWindowName: "f",
        ownership: "app",
        createdAt: "",
        updatedAt: "",
        archivedAt: null
      }
    });
    expect(feedback.isError).toBeFalsy();
    expect(feedback.result).toEqual({
      ok: true,
      id: memory.id,
      outcome: "used"
    });

    const updated = await manager.get(memory.id);
    expect(updated?.useCount).toBe(1);
    expect(updated?.feedback.used).toBe(1);
    expect(updated?.metadata?.lastFeedbackSource).toBe("agent_feedback");
    expect(updated?.metadata?.lastFeedbackThreadId).toBe("thread-1");
  } finally {
    env.cleanup();
  }
});

test("memory tools: feedback reports missing id as a tool error", async () => {
  const env = freshStoresEnv("md-memory-tool-missing-");
  try {
    const manager = new MemoryManager(new LocalMemoryProvider(env.store.db));
    const registry = new ToolRegistry();
    registerMemoryTools(registry, manager, "manager");
    const dispatcher = new ToolDispatcher(registry);

    const feedback = await dispatcher.dispatch({
      toolCallId: "c1",
      toolName: "memory_feedback",
      args: {
        id: "?",
        outcome: "used",
        note: "attempted without an exact id"
      }
    }, {
      threadId: "thread-1",
      wakeId: "wake-1",
      scope: { kind: "manager", managerDir: "/tmp", projectWorkingDirs: [] }
    });

    expect(feedback.isError).toBe(true);
    expect(feedback.error).toContain("memory not found: ?");
  } finally {
    env.cleanup();
  }
});

test("memory tools: overview schema allows explicit project and feature ids", () => {
  const env = freshStoresEnv("md-memory-tool-overview-schema-");
  try {
    const manager = new MemoryManager(new LocalMemoryProvider(env.store.db));
    const registry = new ToolRegistry();
    registerMemoryTools(registry, manager, "manager");

    expect(registry.getDefinition("memory_search")!.parameters.safeParse({
      query: "tmux-pane",
      projectId: "project-1",
      featureId: "feature-1"
    }).success).toBe(true);
    expect(registry.getDefinition("memory_remember")!.parameters.safeParse({
      content: "Use the tmux-pane skill before terminal actions.",
      scope: "feature",
      projectId: "project-1",
      featureId: "feature-1"
    }).success).toBe(true);
  } finally {
    env.cleanup();
  }
});
