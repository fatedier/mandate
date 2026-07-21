import { expect, test } from "bun:test";
import {
  buildFeatureArchiveMemorySource,
  buildNewChatMemorySource
} from "../src/server/runtime/agent-memory-hooks.js";
import { freshStoresEnv, seedFeature, seedProject } from "./helpers/fixtures.js";

test("buildFeatureArchiveMemorySource captures compact feature transcript before archive", () => {
  const env = freshStoresEnv("md-feature-archive-memory-source-");
  try {
    const projectId = seedProject(env.projects, { name: "frp", tmuxSessionName: "frp" });
    const featureId = seedFeature(env.features, projectId, {
      name: "wire protocol",
      mode: "new-branch-new-worktree",
      branch: "wire-v2",
      worktreePath: "/tmp/frp-wire",
      tmuxWindowName: "wire"
    });
    const thread = env.agentStore.getOrCreateThread("worker", featureId);
    const user = env.agentStore.appendMessage({
      threadId: thread.id,
      role: "user",
      source: "user",
      content: { type: "text", text: "Prefer UDP v2 framing only after negotiated support." }
    });
    env.agentStore.appendMessage({
      threadId: thread.id,
      role: "assistant",
      source: "user",
      content: { type: "assistant", text: "Implemented and verified with tests." }
    });

    const source = buildFeatureArchiveMemorySource(featureId, {
      agentStore: env.agentStore,
      projectsStore: env.projects,
      featuresStore: env.features
    });

    expect(source).not.toBeNull();
    expect(source!.scope).toBe("feature");
    expect(source!.projectId).toBe(projectId);
    expect(source!.featureId).toBe(featureId);
    expect(source!.threadId).toBe(thread.id);
    expect(source!.messageIds).toContain(user.id);
    expect(source!.content).toContain("Feature archive transcript");
    expect(source!.content).toContain("Feature: wire protocol");
    expect(source!.content).toContain("Branch: wire-v2");
    expect(source!.content).toContain("Prefer UDP v2 framing");
    expect(source!.metadata).toMatchObject({
      sourceKind: "featureArchive",
      featureName: "wire protocol",
      projectName: "frp"
    });
  } finally {
    env.cleanup();
  }
});

test("archive and new-chat memory sources use the full active message window", () => {
  const env = freshStoresEnv("md-memory-source-active-window-");
  try {
    const projectId = seedProject(env.projects, { name: "frp", tmuxSessionName: "frp" });
    const featureId = seedFeature(env.features, projectId, {
      name: "active window",
      tmuxWindowName: "active-window"
    });
    const thread = env.agentStore.getOrCreateThread("worker", featureId);
    env.agentStore.appendMessage({
      threadId: thread.id,
      role: "user",
      source: "user",
      content: { type: "text", text: "old pre-summary detail should already be covered" }
    });
    const summary = env.agentStore.appendMessage({
      threadId: thread.id,
      role: "user",
      source: "compression",
      content: {
        type: "summary",
        summary: "latest summary carries the older durable context",
        replacedRange: [1, 1],
        replacedCount: 1
      }
    });
    for (let i = 0; i < 60; i += 1) {
      env.agentStore.appendMessage({
        threadId: thread.id,
        role: "user",
        source: "user",
        content: { type: "text", text: `active message ${i}` }
      });
    }

    const featureSource = buildFeatureArchiveMemorySource(featureId, {
      agentStore: env.agentStore,
      projectsStore: env.projects,
      featuresStore: env.features
    });
    const newChatSource = buildNewChatMemorySource(thread.id, {
      agentStore: env.agentStore,
      projectsStore: env.projects,
      featuresStore: env.features
    });

    for (const source of [featureSource, newChatSource]) {
      expect(source).not.toBeNull();
      expect(source!.messageIds?.[0]).toBe(summary.id);
      expect(source!.content).toContain("latest summary carries the older durable context");
      expect(source!.content).toContain("active message 0");
      expect(source!.content).toContain("active message 59");
      expect(source!.content).not.toContain("old pre-summary detail should already be covered");
    }
  } finally {
    env.cleanup();
  }
});
