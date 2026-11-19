import { expect, test } from "bun:test";
import { buildReadWorkerThreadTool } from "../src/server/modules/workers/tools/read-worker-thread.js";
import { freshStoresEnv, seedWorker, seedProject } from "./helpers/fixtures.js";
import { toolContext } from "./helpers/typed.js";
import { parseCut } from "./helpers/cut-line.js";
import { maybeSpoolToolResult } from "../src/server/modules/agent/tool-output-spool.js";

type ThreadMessage = NonNullable<Awaited<ReturnType<ReturnType<typeof buildReadWorkerThreadTool>["handler"]>>["messages"]>[number];

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
  const workerId = seedWorker(env.workers, pId, { name: "login", tmuxWindowName: "login" });
  return { agent: env.agentStore, workers: env.workers, workerId };
}

test("read_worker_thread: returns last N active messages (custom limit)", async () => {
  const { agent, workers, workerId } = setup();
  const t = agent.getOrCreateThread("worker", workerId);
  for (let i = 0; i < 30; i++) {
    agent.appendMessage({
      threadId: t.id, role: "user", source: "user",
      content: { type: "text", text: `m${i}` }
    });
  }
  const tool = buildReadWorkerThreadTool({ agentStore: agent, workersStore: workers });
  const r = await tool.handler({ workerId: workerId, limit: 5 }, toolContext());
  expect(r.messages?.length).toBe(5);
  expect(textOf(r.messages?.[4])).toBe("m29");
  expect(textOf(r.messages?.[0])).toBe("m25");
  // Widened to a plain record to read a member its type does not have: it must not be there.
  const first: Record<string, unknown> = r.messages![0]!;
  expect(first.id).toBeUndefined();
});

test("read_worker_thread: what only the worker's model reads is left out, before the limit", async () => {
  const { agent, workers, workerId } = setup();
  const t = agent.getOrCreateThread("worker", workerId);
  agent.appendMessage({ threadId: t.id, role: "user", source: "user", content: { type: "text", text: "go" } });
  agent.appendMessage({ threadId: t.id, role: "assistant", source: "self", content: { type: "assistant", text: "The plan has three par" } });
  for (const source of ["runtime-context", "plan-reminder", "output-limit"] as const) {
    agent.appendMessage({ threadId: t.id, role: "user", source, content: { type: "text", text: `model only: ${source}` } });
  }
  const tool = buildReadWorkerThreadTool({ agentStore: agent, workersStore: workers });
  const r = await tool.handler({ workerId: workerId, limit: 2 }, toolContext());
  expect(r.messages?.map((m) => m.source)).toEqual(["user", "self"]);
});

test("read_worker_thread: default limit is 10", async () => {
  const { agent, workers, workerId } = setup();
  const t = agent.getOrCreateThread("worker", workerId);
  for (let i = 0; i < 50; i++) {
    agent.appendMessage({
      threadId: t.id, role: "user", source: "user",
      content: { type: "text", text: `m${i}` }
    });
  }
  const tool = buildReadWorkerThreadTool({ agentStore: agent, workersStore: workers });
  const r = await tool.handler({ workerId: workerId }, toolContext());
  expect(r.messages?.length).toBe(10);
  expect(textOf(r.messages?.[9])).toBe("m49");
});

test("read_worker_thread: omits view_image base64 payloads", async () => {
  const { agent, workers, workerId } = setup();
  const t = agent.getOrCreateThread("worker", workerId);
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
  const tool = buildReadWorkerThreadTool({ agentStore: agent, workersStore: workers });
  const r = await tool.handler({ workerId: workerId }, toolContext());
  const result = toolResultOf(r.messages?.[0]);
  expect(result).toContain("[omitted 9 byte image]");
  expect(result).not.toContain(imageBase64);
});

test("read_worker_thread: empty array when no thread yet", async () => {
  const { agent, workers, workerId } = setup();
  const tool = buildReadWorkerThreadTool({ agentStore: agent, workersStore: workers });
  const r = await tool.handler({ workerId: workerId }, toolContext());
  expect(r.messages).toEqual([]);
});

test("read_worker_thread: error for missing worker", async () => {
  const { agent, workers } = setup();
  const tool = buildReadWorkerThreadTool({ agentStore: agent, workersStore: workers });
  const r = await tool.handler({ workerId: "nope" }, toolContext());
  expect(String(r.error)).toMatch(/not found/i);
});

test("read_worker_thread: zod rejects limit > 50", async () => {
  const { agent, workers, workerId } = setup();
  const tool = buildReadWorkerThreadTool({ agentStore: agent, workersStore: workers });
  // Direct handler call doesn't run zod, so simulate via parse.
  const result = tool.parameters.safeParse({ workerId: workerId, limit: 51 });
  expect(result.success).toBe(false);
});

test("read_worker_thread: a long text, reply, tool result or summary is cut at 4,000 characters, the whole saved for the reader", async () => {
  const { agent, workers, workerId } = setup();
  const t = agent.getOrCreateThread("worker", workerId);
  const summed = `${"s".repeat(4100)}!`;
  const said = `${"u".repeat(4999)}?`;
  const replied = `${"a".repeat(5999)}.`;
  const output = `${"o".repeat(4500)}$`;
  agent.appendMessage({ threadId: t.id, role: "user", source: "compression", content: { type: "summary", summary: summed, replacedRange: [0, 0], replacedCount: 0, compactedCount: 0, retained: [] } });
  agent.appendMessage({ threadId: t.id, role: "user", source: "user", content: { type: "text", text: said } });
  agent.appendMessage({ threadId: t.id, role: "assistant", source: "self", content: { type: "assistant", text: replied, toolCalls: [{ toolCallId: "c1", toolName: "bash", args: { command: "make" } }] } });
  agent.appendMessage({ threadId: t.id, role: "tool", source: "self", content: { type: "tool_result", toolCallId: "c1", toolName: "bash", result: output } });
  const tool = buildReadWorkerThreadTool({ agentStore: agent, workersStore: workers });
  const r = await tool.handler({ workerId: workerId }, toolContext({ threadId: "thr_manager" }));
  const summary = r.messages?.[0]?.content;
  if (summary?.type !== "summary") throw new Error("expected the summary");
  expect(parseCut(summary.summary)).toEqual({ kept: "s".repeat(4000), first: 4000, of: 4101, whole: summed });
  expect(summary.summaryTruncated).toBe(true);
  const text = r.messages?.[1]?.content;
  expect(parseCut(textOf(r.messages?.[1]))).toEqual({ kept: "u".repeat(4000), first: 4000, of: 5000, whole: said });
  expect(text?.type === "text" && text.textTruncated).toBe(true);
  const reply = r.messages?.[2]?.content;
  if (reply?.type !== "assistant") throw new Error("expected the reply");
  expect(parseCut(reply.text!)).toEqual({ kept: "a".repeat(4000), first: 4000, of: 6000, whole: replied });
  expect(reply.textTruncated).toBe(true);
  const result = r.messages?.[3]?.content;
  expect(parseCut(toolResultOf(r.messages?.[3])!)).toEqual({ kept: "o".repeat(4000), first: 4000, of: 4501, whole: output });
  expect(result?.type === "tool_result" && result.resultTruncated).toBe(true);
});

test("read_worker_thread: an archived worker's thread is not read", async () => {
  const { agent, workers, workerId } = setup();
  const t = agent.getOrCreateThread("worker", workerId);
  agent.appendMessage({ threadId: t.id, role: "user", source: "user", content: { type: "text", text: "go" } });
  workers.archive(workerId);
  const tool = buildReadWorkerThreadTool({ agentStore: agent, workersStore: workers });
  expect(await tool.handler({ workerId: workerId }, toolContext())).toStrictEqual({ error: `worker not found: ${workerId}` });
});

// A key in a worker's chat (said, or in a command and what it printed) is
// hidden from the manager reading it, as a history search hides it.
test("read_worker_thread: secrets in messages, commands and their output come back hidden", async () => {
  const { agent, workers, workerId } = setup();
  const t = agent.getOrCreateThread("worker", workerId);
  agent.appendMessage({ threadId: t.id, role: "user", source: "manager", content: { type: "text", text: "token=ghp_abcdefghijklmnopqrstuvwx is the deploy token" } });
  agent.appendMessage({
    threadId: t.id, role: "assistant", source: "self",
    content: { type: "assistant", text: "Checking.", toolCalls: [{ toolCallId: "c1", toolName: "bash", args: { command: "curl -H 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123' https://api.example.com" } }] }
  });
  agent.appendMessage({ threadId: t.id, role: "tool", source: "self", content: { type: "tool_result", toolCallId: "c1", toolName: "bash", result: "stdout:\napi_key: sk-test-abcdefghijklmnop" } });
  const tool = buildReadWorkerThreadTool({ agentStore: agent, workersStore: workers });
  const r = await tool.handler({ workerId: workerId, limit: 10 }, toolContext());
  const all = JSON.stringify(r.messages);
  expect(all).not.toContain("ghp_abcdefghijklmnop");
  expect(all).not.toContain("abcdefghijklmnopqrstuvwxyz0123");
  expect(all).not.toContain("sk-test-abcdefghijklmnop");
  expect(all).toContain("Checking.");
});

// Quoted in a command, a key is escaped once the arguments are JSON; it is
// hidden all the same, in arguments, in a structured result, and in a
// secret-named property.
test("read_worker_thread: a quoted key in a command, a structured result, or a secret-named property is hidden too", async () => {
  const { agent, workers, workerId } = setup();
  const t = agent.getOrCreateThread("worker", workerId);
  agent.appendMessage({
    threadId: t.id, role: "assistant", source: "self",
    content: { type: "assistant", text: "Setting it.", toolCalls: [{ toolCallId: "c2", toolName: "bash", args: { command: 'export API_KEY="example-credential-123456" && run' } }] }
  });
  agent.appendMessage({ threadId: t.id, role: "tool", source: "self", content: { type: "tool_result", toolCallId: "c2", toolName: "bash", result: { stdout: 'export API_KEY="example-credential-123456"', config: { apiKey: "zyxwvutsrqponmlk9876" } } } });
  const tool = buildReadWorkerThreadTool({ agentStore: agent, workersStore: workers });
  const r = await tool.handler({ workerId: workerId, limit: 10 }, toolContext());
  const all = JSON.stringify(r.messages);
  expect(all).not.toContain("example-credential-123456");
  expect(all).not.toContain("zyxwvutsrqponmlk9876");
  expect(all).toContain("Setting it.");
});

// A long output was saved whole when the worker ran the command; what is
// stored is a preview and that file's path. The manager is given a copy of
// the whole with its secrets hidden, saved as its own, never the original.
test("read_worker_thread: a long output saved at the call is given as a hidden copy of the reader's own, not the original's path", async () => {
  const { agent, workers, workerId } = setup();
  const t = agent.getOrCreateThread("worker", workerId);
  const output = `${"build ok\n".repeat(5000)}api_key: sk-test-abcdefghijklmnop\n`;
  const stored = maybeSpoolToolResult({ result: output, toolName: "bash", toolCallId: "c3", threadId: t.id, wakeId: "w1" }) as string;
  const original = /Full output saved to:\n(.+)\n/.exec(stored)![1]!;
  agent.appendMessage({ threadId: t.id, role: "assistant", source: "self", content: { type: "assistant", text: "", toolCalls: [{ toolCallId: "c3", toolName: "bash", args: { command: "make" } }] } });
  agent.appendMessage({ threadId: t.id, role: "tool", source: "self", content: { type: "tool_result", toolCallId: "c3", toolName: "bash", result: stored } });
  const tool = buildReadWorkerThreadTool({ agentStore: agent, workersStore: workers });
  const r = await tool.handler({ workerId: workerId, limit: 10 }, toolContext());
  const given = toolResultOf(r.messages?.at(-1))!;
  expect(given).not.toContain(original);
  const cut = parseCut(given)!;
  expect(cut.whole).toContain("api_key: [REDACTED]");
  expect(cut.whole).not.toContain("sk-test-abcdefghijklmnop");
  expect(cut.whole!.startsWith("build ok\n")).toBe(true);
});

// A secret's line is hidden in a multi-line argument, and only that line:
// what follows it is the manager's to read.
test("read_worker_thread: in a multi-line argument only the secret's line is hidden; a secret-named property is hidden whole", async () => {
  const { agent, workers, workerId } = setup();
  const t = agent.getOrCreateThread("worker", workerId);
  const content = "headers:\n  cookie: session=abc123456789xyz\n  accept: application/json\nconst limit = 128;";
  agent.appendMessage({
    threadId: t.id, role: "assistant", source: "self",
    content: { type: "assistant", text: "Writing.", toolCalls: [{ toolCallId: "c4", toolName: "write", args: { path: "client.yaml", content, auth: { password: "hunter2-but-longer" } } }] }
  });
  const tool = buildReadWorkerThreadTool({ agentStore: agent, workersStore: workers });
  const r = await tool.handler({ workerId: workerId, limit: 10 }, toolContext());
  const all = JSON.stringify(r.messages);
  expect(all).not.toContain("abc123456789xyz");
  expect(all).not.toContain("hunter2-but-longer");
  expect(all).toContain("accept: application/json");
  expect(all).toContain("const limit = 128;");
});

// Hidden in a structured result, a header's line goes, and nothing after it.
test("read_worker_thread: a cookie header in a structured result hides that line only", async () => {
  const { agent, workers, workerId } = setup();
  const t = agent.getOrCreateThread("worker", workerId);
  agent.appendMessage({ threadId: t.id, role: "assistant", source: "self", content: { type: "assistant", text: "", toolCalls: [{ toolCallId: "c6", toolName: "bash", args: { command: "curl -v" } }] } });
  agent.appendMessage({ threadId: t.id, role: "tool", source: "self", content: { type: "tool_result", toolCallId: "c6", toolName: "bash", result: { stdout: "< cookie: session=abc123456789xyz\n< content-type: json\nbody done", exitCode: 0 } } });
  const tool = buildReadWorkerThreadTool({ agentStore: agent, workersStore: workers });
  const r = await tool.handler({ workerId: workerId, limit: 10 }, toolContext());
  const given = toolResultOf(r.messages?.at(-1))!;
  expect(given).not.toContain("abc123456789xyz");
  expect(given).toContain("content-type: json");
  expect(given).toContain("body done");
  expect(given).toContain("exitCode");
});
