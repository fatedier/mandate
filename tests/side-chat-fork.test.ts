import { expect, test } from "bun:test";
import type { AgentStore } from "../src/server/modules/agent/agent-store.js";
import { AgentHistoryStore } from "../src/server/modules/agent/history-store.js";
import { prepareAiSdkMessages } from "../src/server/modules/agent/wake-message-adapter.js";
import { windowExtraction } from "../src/server/runtime/agent-memory-hooks.js";
import { ProjectsStore } from "../src/server/modules/projects/projects-store.js";
import { WorkersStore } from "../src/server/modules/workers/workers-store.js";
import { freshAgentEnv } from "./helpers/fixtures.js";

// A side chat starts from the personal agent's conversation as it stands:
// its rows are copied, so the model reads the same prefix (and the
// provider's cache of the main conversation serves it), and nothing the main
// conversation does afterwards reaches it.

const REPLAY = { includeProviderState: true, replayTo: "claude-test" } as const;

function seedPersonal(agentStore: AgentStore) {
  const personal = agentStore.getOrCreatePersonalThread();
  agentStore.ensureSystemMessage(personal.id, "You are the user's personal agent.");
  const kept = agentStore.appendMessage({
    threadId: personal.id, role: "user", source: "user",
    content: { type: "text", text: "keep the release notes short" }
  });
  agentStore.appendMessage({ threadId: personal.id, role: "assistant", source: "self", content: { type: "assistant", text: "noted" } });
  agentStore.appendMessage({
    threadId: personal.id, role: "user", source: "compression",
    content: { type: "summary", summary: "earlier: release planning", replacedRange: [1, 2], replacedCount: 2, compactedCount: 2, retained: [{ id: kept.id }] }
  });
  agentStore.appendMessage({
    threadId: personal.id, role: "user", source: "runtime-context",
    content: { type: "text", text: "Now: two threads open." }
  });
  agentStore.appendMessage({
    threadId: personal.id, role: "user", source: "user",
    content: { type: "text", text: "what is left for the release?", arrivedAt: "2026-01-05T09:00:00.000Z" }
  });
  agentStore.appendMessage({
    threadId: personal.id, role: "assistant", source: "self",
    content: { type: "assistant", text: "Let me look.", toolCalls: [{ toolCallId: "call-1", toolName: "read", args: { path: "/tmp/notes.md" } }] }
  });
  agentStore.appendMessage({
    threadId: personal.id, role: "tool", source: "self",
    content: { type: "tool_result", toolCallId: "call-1", toolName: "read", result: "two items left" }
  });
  agentStore.appendMessage({ threadId: personal.id, role: "assistant", source: "self", content: { type: "assistant", text: "Two items are left." } });
  return personal;
}

const modelView = (agentStore: AgentStore, threadId: string) =>
  prepareAiSdkMessages(agentStore.getActiveMessages(threadId), { ...REPLAY, includeImages: true, timeZone: "UTC" });

test("a fork renders to the model exactly as the main conversation does", () => {
  const env = freshAgentEnv("md-side-fork-");
  const personal = seedPersonal(env.agentStore);
  const side = env.agentStore.createSideChatThread();
  expect(side.scope).toBe("side_chat");
  expect(side.scopeId).toBeNull();

  const copied = env.agentStore.copyConversation(personal.id, side.id);

  expect(copied.copied).toBe(env.agentStore.getActiveMessages(personal.id).length + 1);
  expect(env.agentStore.getSystemMessage(side.id)?.content).toEqual(env.agentStore.getSystemMessage(personal.id)!.content);
  expect(modelView(env.agentStore, side.id)).toEqual(modelView(env.agentStore, personal.id));
  // Copies, not the same rows, and kept in the order the model reads them.
  const sideRows = env.agentStore.getActiveMessages(side.id);
  expect(sideRows.every((m) => m.threadId === side.id && m.wakeId === null)).toBe(true);
  expect(sideRows.map((m) => m.createdAt)).toEqual(env.agentStore.getActiveMessages(personal.id).map((m) => m.createdAt));
  expect(copied.lastSeq).toBe(sideRows.at(-1)!.seq);
});

test("a fork is a copy: compacting the main conversation later leaves it alone", () => {
  const env = freshAgentEnv("md-side-fork-copy-");
  const personal = seedPersonal(env.agentStore);
  const side = env.agentStore.createSideChatThread();
  env.agentStore.copyConversation(personal.id, side.id);
  const before = modelView(env.agentStore, side.id);

  env.agentStore.appendMessage({ threadId: personal.id, role: "user", source: "user", content: { type: "text", text: "a new event" } });
  env.agentStore.appendMessage({
    threadId: personal.id, role: "user", source: "compression",
    content: { type: "summary", summary: "everything so far", replacedRange: [1, 9], replacedCount: 9, compactedCount: 9, retained: [] }
  });
  env.agentStore.ensureSystemMessage(personal.id, "A newer prompt.");

  expect(modelView(env.agentStore, side.id)).toEqual(before);
  expect(env.agentStore.getSystemMessage(side.id)?.content).toEqual({ type: "text", text: "You are the user's personal agent." });
});

test("a side chat thread is not searched or extracted", () => {
  const env = freshAgentEnv("md-side-fork-private-");
  const personal = seedPersonal(env.agentStore);
  const side = env.agentStore.createSideChatThread();
  env.agentStore.copyConversation(personal.id, side.id);
  env.agentStore.appendMessage({ threadId: side.id, role: "user", source: "user", content: { type: "text", text: "zzpangolin pricing idea" } });
  const manager = env.agentStore.createManagerThread("elsewhere");

  const history = new AgentHistoryStore(env.store.db);
  const found = history.search({ callerThreadId: manager.id, query: "zzpangolin", includeOwnThread: true });
  expect(found.threads).toEqual([]);
  // The copied rows are not indexed again: the personal agent's words are
  // found in its own thread only.
  const release = history.search({ callerThreadId: manager.id, query: "release", includeOwnThread: true });
  expect(release.threads.map((t) => t.id)).toEqual([personal.id]);

  const deps = { agentStore: env.agentStore, projectsStore: new ProjectsStore(env.store.db), workersStore: new WorkersStore(env.store.db) };
  expect(windowExtraction(side.id, env.agentStore.getActiveMessages(side.id), deps)).toBeNull();
});
