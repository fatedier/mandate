import { expect, test } from "bun:test";
import { buildUpdateFeatureDigestTool } from "../src/server/modules/agent/tools/feature-digest.js";
import { freshStoresEnv, seedFeature, seedProject } from "./helpers/fixtures.js";

test("update_feature_digest writes compact feature context for overview", async () => {
  const env = freshStoresEnv("md-feature-digest-");
  try {
    const projectId = seedProject(env.projects, { name: "P" });
    const featureId = seedFeature(env.features, projectId, { name: "F" });
    const thread = env.agentStore.getOrCreateThread("worker", featureId);
    env.agentStore.appendMessage({
      threadId: thread.id,
      role: "user",
      source: "user",
      content: { type: "text", text: "Should the feature chat bypass overview?" }
    });
    const second = env.agentStore.appendMessage({
      threadId: thread.id,
      role: "assistant",
      source: "self",
      content: { type: "assistant", text: "Yes, but overview needs a digest." }
    });
    const tool = buildUpdateFeatureDigestTool({ agentStore: env.agentStore });

    const result = await tool.handler({
      summary: "Feature chat should be the direct design surface.",
      decisions: ["Default feature-page chat to the feature agent."],
      openQuestions: ["How should overview stay informed?"],
      constraints: ["Do not turn normal discussion into queued tasks."]
    }, {
      threadId: thread.id,
      wakeId: "wake-1",
      scope: {} as any,
      feature: env.features.getById(featureId)!,
      project: env.projects.getById(projectId)!,
      paneRuntime: {} as any
    });

    expect(result).toEqual({
      ok: true,
      featureId,
      lastSeqCovered: second.seq
    });
    expect(env.agentStore.getFeatureDigest(featureId)).toMatchObject({
      featureId,
      summary: "Feature chat should be the direct design surface.",
      decisions: ["Default feature-page chat to the feature agent."],
      openQuestions: ["How should overview stay informed?"],
      constraints: ["Do not turn normal discussion into queued tasks."],
      lastSeqCovered: second.seq,
      updatedByThreadId: thread.id
    });
  } finally {
    env.cleanup();
  }
});
