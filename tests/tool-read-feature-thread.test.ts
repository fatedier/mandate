import { expect, test } from "bun:test";
import { buildReadFeatureThreadTool } from "../src/server/modules/features/tools/read-feature-thread.js";
import { freshStoresEnv, seedFeature, seedProject } from "./helpers/fixtures.js";

function setup() {
  const env = freshStoresEnv("md-rft-");
  const pId = seedProject(env.projects, { name: "alpha", workingDir: "/a", tmuxSessionName: "alpha" });
  const fId = seedFeature(env.features, pId, { name: "login", tmuxWindowName: "login" });
  return { agent: env.agentStore, features: env.features, fId, cleanup: env.cleanup };
}

test("read_feature_thread: returns last N active messages (custom limit)", async () => {
  const { agent, features, fId, cleanup } = setup();
  try {
    const t = agent.getOrCreateThread("worker", fId);
    for (let i = 0; i < 30; i++) {
      agent.appendMessage({
        threadId: t.id, role: "user", source: "user",
        content: { type: "text", text: `m${i}` }
      });
    }
    const tool = buildReadFeatureThreadTool({ agentStore: agent, featuresStore: features });
    const r = await tool.handler({ featureId: fId, limit: 5 }, {} as any);
    expect(r.messages?.length).toBe(5);
    expect((r.messages?.[4]!.content as any).text).toBe("m29");
    expect((r.messages?.[0]!.content as any).text).toBe("m25");
    expect((r.messages?.[0] as any).id).toBeUndefined();
  } finally { cleanup(); }
});

test("read_feature_thread: default limit is 10", async () => {
  const { agent, features, fId, cleanup } = setup();
  try {
    const t = agent.getOrCreateThread("worker", fId);
    for (let i = 0; i < 50; i++) {
      agent.appendMessage({
        threadId: t.id, role: "user", source: "user",
        content: { type: "text", text: `m${i}` }
      });
    }
    const tool = buildReadFeatureThreadTool({ agentStore: agent, featuresStore: features });
    const r = await tool.handler({ featureId: fId }, {} as any);
    expect(r.messages?.length).toBe(10);
    expect((r.messages?.[9]!.content as any).text).toBe("m49");
  } finally { cleanup(); }
});

test("read_feature_thread: omits view_image base64 payloads", async () => {
  const { agent, features, fId, cleanup } = setup();
  try {
    const t = agent.getOrCreateThread("worker", fId);
    const imageBase64 = Buffer.from("png-bytes").toString("base64");
    agent.appendMessage({
      threadId: t.id,
      role: "tool",
      source: "self",
      content: {
        type: "tool_result",
        toolCallId: "call-1",
        toolName: "view_image",
        result: {
          type: "view_image_result",
          message: "Viewed image: screenshot.png",
          image: {
            type: "image",
            id: "img-1",
            name: "screenshot.png",
            displayPath: "screenshot.png",
            mediaType: "image/png",
            data: imageBase64,
            sizeBytes: 9
          }
        }
      }
    });
    const tool = buildReadFeatureThreadTool({ agentStore: agent, featuresStore: features });
    const r = await tool.handler({ featureId: fId }, {} as any);
    const result = (r.messages?.[0]!.content as any).result as string;
    expect(result).toContain("[omitted 9 byte image]");
    expect(result).not.toContain(imageBase64);
  } finally { cleanup(); }
});

test("read_feature_thread: empty array when no thread yet", async () => {
  const { agent, features, fId, cleanup } = setup();
  try {
    const tool = buildReadFeatureThreadTool({ agentStore: agent, featuresStore: features });
    const r = await tool.handler({ featureId: fId }, {} as any);
    expect(r.messages).toEqual([]);
  } finally { cleanup(); }
});

test("read_feature_thread: error for missing feature", async () => {
  const { agent, features, cleanup } = setup();
  try {
    const tool = buildReadFeatureThreadTool({ agentStore: agent, featuresStore: features });
    const r = await tool.handler({ featureId: "nope" }, {} as any);
    expect(String(r.error)).toMatch(/not found/i);
  } finally { cleanup(); }
});

test("read_feature_thread: zod rejects limit > 50", async () => {
  const { agent, features, fId, cleanup } = setup();
  try {
    const tool = buildReadFeatureThreadTool({ agentStore: agent, featuresStore: features });
    // Direct handler call doesn't run zod, so simulate via parse.
    const result = tool.parameters.safeParse({ featureId: fId, limit: 51 });
    expect(result.success).toBe(false);
  } finally { cleanup(); }
});
