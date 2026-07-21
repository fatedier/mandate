import { expect, test } from "bun:test";
import { streamText, tool, jsonSchema } from "ai";
import { collectStream } from "../src/server/modules/agent/stream-collector.js";
import { callTextModelForProvider } from "../src/server/modules/llm/text-model.js";
import { codexEvents, codexSse, codexTestModel } from "./helpers/codex.js";

for (const endTurn of [false, true, undefined, "false", 0]) {
  test(`Codex stream exposes only boolean completed end_turn: ${String(endTurn)}`, async () => {
    const model = codexTestModel({
      async fetch() { return codexSse(codexEvents({ text: "hello 中文", endTurn }), 7); }
    });
    const stream = streamText({ model, prompt: "hello", maxRetries: 0 });
    const result = await collectStream(stream.fullStream);
    expect(result.text).toBe("hello 中文");
    expect(result.endTurn).toBe(typeof endTurn === "boolean" ? endTurn : undefined);
    expect(result.usage).toMatchObject({ promptTokens: 12, completionTokens: 4 });
    const metadata = await stream.providerMetadata;
    expect(metadata?.codex?.endTurn).toBe(typeof endTurn === "boolean" ? endTurn : undefined);
  });
}

for (const text of [undefined, "partial response"]) {
  test(`Codex stream rejects EOF without a terminal event (${text ?? "empty"})`, async () => {
    const model = codexTestModel({
      async fetch() { return codexSse(codexEvents({ text }).slice(0, -1)); }
    });
    const stream = streamText({ model, prompt: "hello", maxRetries: 0 });
    await expect(collectStream(stream.fullStream)).rejects.toThrow(/before a terminal response event/);
  });
}

test("Codex stream does not continue an incomplete response with end_turn false", async () => {
  const model = codexTestModel({
    async fetch() {
      return codexSse(codexEvents({
        text: "partial", endTurn: false, terminalType: "response.incomplete", incompleteReason: "max_output_tokens"
      }));
    }
  });
  const stream = streamText({ model, prompt: "hello", maxRetries: 0 });
  expect((await collectStream(stream.fullStream)).endTurn).toBeUndefined();
  expect(await stream.finishReason).toBe("length");
});

test("Codex stream rejects a failed terminal response even without an error body", async () => {
  const model = codexTestModel({
    async fetch() { return codexSse(codexEvents({ terminalType: "response.failed" })); }
  });
  await expect(collectStream(streamText({ model, prompt: "hello", maxRetries: 0 }).fullStream))
    .rejects.toThrow(/stream failed/);
});

test("Codex stream preserves the upstream error instead of replacing it with missing terminal", async () => {
  const model = codexTestModel({
    async fetch() {
      return codexSse([{ type: "error", code: "server_error", message: "specific upstream failure", param: null, sequence_number: 1 }]);
    }
  });
  await expect(collectStream(streamText({ model, prompt: "hello", maxRetries: 0, onError() {} }).fullStream))
    .rejects.toThrow(/specific upstream failure/);
});

test("Codex text-only callers also reject a truncated stream after partial output", async () => {
  const model = codexTestModel({
    async fetch() { return codexSse(codexEvents({ text: "partial" }).slice(0, -1)); }
  });
  await expect(callTextModelForProvider("codex", { model, prompt: "hello", maxRetries: 0, onError() {} }))
    .rejects.toThrow();
});

test("Codex terminal output backfills phase and encrypted reasoning before SDK history is finalized", async () => {
  const model = codexTestModel({
    async fetch() {
      const events = codexEvents({ text: "Checking", phase: "commentary", encryptedReasoning: "terminal-cipher" });
      for (const event of events) {
        if (event.item) {
          event.item = { ...(event.item as object), phase: undefined, encrypted_content: null };
        }
      }
      return codexSse(events);
    }
  });
  const stream = streamText({ model, prompt: "hello", maxRetries: 0 });
  await collectStream(stream.fullStream);
  const messages = await stream.responseMessages;
  const assistant = messages.find(message => message.role === "assistant")!;
  expect(assistant.content).toMatchObject([
    { type: "reasoning", providerOptions: { openai: { reasoningEncryptedContent: "terminal-cipher" } } },
    { type: "text", text: "Checking", providerOptions: { openai: { phase: "commentary" } } }
  ]);
});

test("Codex propagates mid-stream errors to text-only callers", async () => {
  const model = codexTestModel({
    async fetch() {
      return codexSse([
        ...codexEvents({ text: "partial" }).slice(0, -1),
        { type: "error", code: "server_error", message: "failed after output", param: null, sequence_number: 10 }
      ]);
    }
  });
  await expect(callTextModelForProvider("codex", { model, prompt: "hello", maxRetries: 0, onError() {} }))
    .rejects.toThrow();
});

test("Codex cancellation after partial output is not reported as a successful or truncated response", async () => {
  const controller = new AbortController();
  const model = codexTestModel({
    async fetch() { return codexSse(codexEvents({ text: "partial", endTurn: false })); }
  });
  const stream = streamText({ model, prompt: "hello", abortSignal: controller.signal, maxRetries: 0, onError() {} });
  await expect(collectStream(stream.fullStream, {
    onTextDelta() { controller.abort(new Error("canceled by test")); }
  })).rejects.toThrow(/canceled by test/);
});

test("Codex content-filter terminal responses fail instead of completing with partial text", async () => {
  const model = codexTestModel({
    async fetch() { return codexSse(codexEvents({ terminalType: "response.incomplete", incompleteReason: "content_filter" })); }
  });
  await expect(collectStream(streamText({ model, prompt: "hello", maxRetries: 0, onError() {} }).fullStream))
    .rejects.toThrow(/stream failed/);
});

test("Codex rejects a terminal response with an unfinished tool call", async () => {
  const model = codexTestModel({
    async fetch() {
      const events = codexEvents({ toolCall: { name: "lookup", callId: "call_lookup", args: '{"query":' } });
      return codexSse(events.filter(event => event.type !== "response.output_item.done"));
    }
  });
  await expect(collectStream(streamText({ model, prompt: "hello", maxRetries: 0, onError() {} }).fullStream))
    .rejects.toThrow(/unresolved tool calls/);
});

test("Codex accepts a completed tool call when a relay rewrites the done item ID", async () => {
  const model = codexTestModel({
    async fetch() {
      const events = codexEvents({ toolCall: { name: "lookup", callId: "call_lookup", args: '{"query":"value"}' } });
      for (const event of events) {
        if (event.type === "response.output_item.done") {
          event.item = { ...(event.item as object), id: "rewritten-item-id" };
        }
      }
      return codexSse(events);
    }
  });
  const stream = streamText({
    model, prompt: "hello", maxRetries: 0,
    tools: { lookup: tool({ inputSchema: jsonSchema({ type: "object", properties: { query: { type: "string" } } }) }) }
  });
  expect((await collectStream(stream.fullStream)).toolCalls).toEqual([
    { toolName: "lookup", toolCallId: "call_lookup", args: { query: "value" } }
  ]);
});
