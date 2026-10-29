import { expect, test } from "bun:test";
import { buildReadFeatureThreadTool } from "../src/server/modules/features/tools/read-feature-thread.js";
import { freshStoresEnv, seedFeature, seedProject } from "./helpers/fixtures.js";
import { toolContext } from "./helpers/typed.js";
import { parseCut } from "./helpers/cut-line.js";

type ThreadMessage = NonNullable<Awaited<ReturnType<ReturnType<typeof buildReadFeatureThreadTool>["handler"]>>["messages"]>[number];

/** The text of a message the tool returned; throws unless it is a text message. */
function textOf(message: ThreadMessage | undefined): string {
  const content = message?.content;
  if (content?.type !== "text") throw new Error(`expected text content, got ${content?.type}`);
  return content.text;
}

/** The result of a tool-result message the tool returned; throws unless it is one. */
function toolResultOf(message: ThreadMessage | undefined): string | undefined {
  const content = message?.content;
  if (content?.type !== "tool_result") throw new Error(`expected tool_result content, got ${content?.type}`);
  return content.result;
}

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
    const r = await tool.handler({ featureId: fId, limit: 5 }, toolContext());
    expect(r.messages?.length).toBe(5);
    expect(textOf(r.messages?.[4])).toBe("m29");
    expect(textOf(r.messages?.[0])).toBe("m25");
    // Widened to a plain record to read a member its type does not have: it must not be there.
    const first: Record<string, unknown> = r.messages![0]!;
    expect(first.id).toBeUndefined();
  } finally { cleanup(); }
});

test("read_feature_thread: what only the worker's model reads is left out, before the limit", async () => {
  const { agent, features, fId, cleanup } = setup();
  try {
    const t = agent.getOrCreateThread("worker", fId);
    agent.appendMessage({ threadId: t.id, role: "user", source: "user", content: { type: "text", text: "go" } });
    agent.appendMessage({ threadId: t.id, role: "assistant", source: "self", content: { type: "assistant", text: "The plan has three par" } });
    for (const source of ["runtime-context", "plan-reminder", "output-limit"] as const) {
      agent.appendMessage({ threadId: t.id, role: "user", source, content: { type: "text", text: `model only: ${source}` } });
    }
    const tool = buildReadFeatureThreadTool({ agentStore: agent, featuresStore: features });
    const r = await tool.handler({ featureId: fId, limit: 2 }, toolContext());
    expect(r.messages?.map((m) => m.source)).toEqual(["user", "self"]);
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
    const r = await tool.handler({ featureId: fId }, toolContext());
    expect(r.messages?.length).toBe(10);
    expect(textOf(r.messages?.[9])).toBe("m49");
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
    const r = await tool.handler({ featureId: fId }, toolContext());
    const result = toolResultOf(r.messages?.[0]);
    expect(result).toContain("[omitted 9 byte image]");
    expect(result).not.toContain(imageBase64);
  } finally { cleanup(); }
});

test("read_feature_thread: empty array when no thread yet", async () => {
  const { agent, features, fId, cleanup } = setup();
  try {
    const tool = buildReadFeatureThreadTool({ agentStore: agent, featuresStore: features });
    const r = await tool.handler({ featureId: fId }, toolContext());
    expect(r.messages).toEqual([]);
  } finally { cleanup(); }
});

test("read_feature_thread: error for missing feature", async () => {
  const { agent, features, cleanup } = setup();
  try {
    const tool = buildReadFeatureThreadTool({ agentStore: agent, featuresStore: features });
    const r = await tool.handler({ featureId: "nope" }, toolContext());
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

test("read_feature_thread: a long text, reply, tool result or summary is cut at 4,000 characters, the whole saved for the reader", async () => {
  const { agent, features, fId, cleanup } = setup();
  try {
    const t = agent.getOrCreateThread("worker", fId);
    const said = `${"u".repeat(4999)}?`;
    const replied = `${"a".repeat(5999)}.`;
    const output = `${"o".repeat(4500)}$`;
    agent.appendMessage({ threadId: t.id, role: "user", source: "user", content: { type: "text", text: said } });
    agent.appendMessage({ threadId: t.id, role: "assistant", source: "self", content: { type: "assistant", text: replied, toolCalls: [{ toolCallId: "c1", toolName: "bash", args: { command: "make" } }] } });
    agent.appendMessage({ threadId: t.id, role: "tool", source: "self", content: { type: "tool_result", toolCallId: "c1", toolName: "bash", result: output } });
    const tool = buildReadFeatureThreadTool({ agentStore: agent, featuresStore: features });
    const r = await tool.handler({ featureId: fId }, toolContext({ threadId: "thr_manager" }));
    expect(parseCut(textOf(r.messages?.[0]))).toEqual({ kept: "u".repeat(4000), first: 4000, of: 5000, whole: said });
    const reply = r.messages?.[1]?.content;
    if (reply?.type !== "assistant") throw new Error("expected the reply");
    expect(parseCut(reply.text!)).toEqual({ kept: "a".repeat(4000), first: 4000, of: 6000, whole: replied });
    expect(reply.textTruncated).toBe(true);
    expect(parseCut(toolResultOf(r.messages?.[2])!)).toEqual({ kept: "o".repeat(4000), first: 4000, of: 4501, whole: output });
  } finally { cleanup(); }
});
