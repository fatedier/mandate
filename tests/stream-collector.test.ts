import { expect, test } from "bun:test";
import { collectStream } from "../src/server/modules/agent/stream-collector.js";

async function* iter(parts: any[]): AsyncIterable<any> {
  for (const p of parts) yield p;
}

test("collectStream: concatenates text-deltas and emits onTextDelta", async () => {
  const deltas: Array<{ delta: string; total: string }> = [];
  const r = await collectStream(
    iter([
      { type: "text-delta", text: "Hel" },
      { type: "text-delta", text: "lo" },
      { type: "finish", usage: { inputTokens: 5, outputTokens: 2 } }
    ]),
    { onTextDelta: (delta, total) => deltas.push({ delta, total }) }
  );
  expect(r.text).toBe("Hello");
  expect(deltas).toEqual([
    { delta: "Hel", total: "Hel" },
    { delta: "lo", total: "Hello" }
  ]);
  expect(r.usage).toEqual({ promptTokens: 5, completionTokens: 2 });
});

test("collectStream: collects tool calls with input mapped to args", async () => {
  const r = await collectStream(iter([
    { type: "tool-call", toolCallId: "c1", toolName: "bash", input: { cmd: "ls" } },
    { type: "tool-call", toolCallId: "c2", toolName: "read", input: { path: "/x" } },
    { type: "finish", usage: { inputTokens: 0, outputTokens: 0 } }
  ]));
  expect(r.toolCalls).toEqual([
    { toolCallId: "c1", toolName: "bash", args: { cmd: "ls" } },
    { toolCallId: "c2", toolName: "read", args: { path: "/x" } }
  ]);
});

test("collectStream: ignores OpenAI reasoning state and reasoning text", async () => {
  const r = await collectStream(iter([
    {
      type: "reasoning-start",
      id: "rs_1:0",
      providerMetadata: {
        openai: {
          itemId: "rs_1",
          reasoningEncryptedContent: "encrypted-v1"
        }
      }
    },
    { type: "reasoning-delta", id: "rs_1:0", text: "hidden chain of thought" },
    {
      type: "reasoning-end",
      id: "rs_1:0",
      providerMetadata: {
        openai: {
          itemId: "rs_1",
          reasoningEncryptedContent: "encrypted-v2"
        }
      }
    },
    { type: "text-delta", text: "done" },
    { type: "finish", usage: { inputTokens: 3, outputTokens: 2 } }
  ]));

  expect(r.text).toBe("done");
  expect(JSON.stringify(r)).not.toContain("hidden chain of thought");
  expect(JSON.stringify(r)).not.toContain("encrypted-v2");
});

test("collectStream: accepts both `text` (v6) and `delta` (provider) on text-delta", async () => {
  const r = await collectStream(iter([
    { type: "text-delta", delta: "fall" },
    { type: "text-delta", text: "back" },
    { type: "finish", usage: {} }
  ]));
  expect(r.text).toBe("fallback");
});

test("collectStream: prefers totalUsage over usage on finish", async () => {
  const r = await collectStream(iter([
    { type: "finish", totalUsage: { inputTokens: 100, outputTokens: 50 }, usage: { inputTokens: 7, outputTokens: 3 } }
  ]));
  expect(r.usage).toEqual({ promptTokens: 100, completionTokens: 50 });
});

test("collectStream: throws on `error` events with the provider message", async () => {
  await expect(
    collectStream(iter([{ type: "error", error: { message: "rate limited" } }]))
  ).rejects.toThrow(/rate limited/);
});

test("collectStream: formats nested provider error events", async () => {
  await expect(
    collectStream(iter([{
      type: "error",
      error: {
        type: "error",
        sequence_number: 2,
        error: {
          type: "service_unavailable_error",
          code: "server_is_overloaded",
          message: "Our servers are currently overloaded. Please try again later.",
          param: null
        }
      }
    }]))
  ).rejects.toThrow(/server_is_overloaded/);
});

test("collectStream: throws on abort events with the abort reason", async () => {
  await expect(
    collectStream(iter([{ type: "abort", reason: "The operation timed out." }]))
  ).rejects.toThrow(/timed out/);
});

test("collectStream: ignores unknown event types (start, reasoning, etc.)", async () => {
  const r = await collectStream(iter([
    { type: "start" },
    { type: "text-start" },
    { type: "text-delta", text: "x" },
    { type: "text-end" },
    { type: "reasoning-delta", delta: "thinking..." },
    { type: "finish", usage: { inputTokens: 1, outputTokens: 1 } }
  ]));
  expect(r.text).toBe("x");
  expect(r.usage).toEqual({ promptTokens: 1, completionTokens: 1 });
});

test("collectStream: defaults to zero usage when finish has no usage shape", async () => {
  const r = await collectStream(iter([{ type: "text-delta", text: "ok" }]));
  expect(r.usage).toEqual({ promptTokens: 0, completionTokens: 0 });
});

test("collectStream: rejects empty streams that end without finish", async () => {
  await expect(
    collectStream(iter([{ type: "start" }, { type: "text-start" }]))
  ).rejects.toThrow(/without a finish event or content/);
});
