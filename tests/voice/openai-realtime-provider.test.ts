import { expect, test, beforeEach } from "bun:test";
import { z } from "zod";
import { createMockWebSocket, type MockWebSocket } from "./helpers/mock-ws.js";
import { OpenAIRealtimeProvider } from "../../src/server/modules/voice/openai-realtime-provider.js";
import type { VoiceSessionEvents, VoiceProviderConfig } from "../../src/server/modules/voice/voice-provider.js";
import type { ToolDefinition } from "../../src/server/modules/agent/tool-registry.js";

let mock: MockWebSocket;

beforeEach(() => {
  mock = createMockWebSocket();
});

function makeEvents(): VoiceSessionEvents & { received: any[] } {
  const received: any[] = [];
  return {
    received,
    onAudio: (f) => received.push({ kind: "audio", frame: f }),
    onTranscript: (d) => received.push({ kind: "transcript", delta: d }),
    onToolCall: (c) => received.push({ kind: "tool", call: c }),
    onSpeechStarted: () => received.push({ kind: "speech-started" }),
    onResponseCreated: () => received.push({ kind: "response-created" }),
    onResponseItemAdded: (info) => received.push({ kind: "response-item-added", info }),
    onResponseDone: () => received.push({ kind: "response-done" }),
    onError: (e) => received.push({ kind: "error", err: e }),
    onClose: () => received.push({ kind: "close" })
  };
}

const FAKE_TOOLS: ToolDefinition[] = [{
  name: "list_projects",
  description: "List",
  parameters: z.object({}),
  approval: "never",
  handler: async () => ({})
}];

const baseConfig: VoiceProviderConfig = {
  apiKey: "sk-test",
  model: "gpt-realtime-mini",
  voice: "alloy",
  language: "auto",
  systemPrompt: "You are the voice agent.",
  tools: FAKE_TOOLS
};

test("OpenAIRealtimeProvider: connects and sends session.update with tools", async () => {
  const provider = new OpenAIRealtimeProvider({ wsFactory: () => mock as any });
  const events = makeEvents();
  const sessionPromise = provider.startSession(baseConfig, events);

  mock.fireOpen();

  await mock.waitForSentMessages(1);
  const sent = JSON.parse(mock.sent[0]);
  expect(sent.type).toBe("session.update");
  expect(sent.session.type).toBe("realtime");
  expect(sent.session.model).toBe("gpt-realtime-mini");
  expect(sent.session.instructions).toBe("You are the voice agent.");
  expect(sent.session.output_modalities).toEqual(["audio"]);
  expect(sent.session.tools).toHaveLength(1);
  expect(sent.session.tools[0].name).toBe("list_projects");
  // GA nested audio schema — the only place voice / audio format actually
  // takes effect on the gpt-realtime model.
  expect(sent.session.audio?.output?.voice).toBe("alloy");
  expect(sent.session.audio?.output?.format?.type).toBe("audio/pcm");
  expect(sent.session.audio?.output?.format?.rate).toBe(24000);
  expect(sent.session.audio?.input?.format?.type).toBe("audio/pcm");
  expect(sent.session.audio?.input?.transcription?.model).toBe("gpt-4o-transcribe");
  expect(sent.session.audio?.input?.turn_detection?.type).toBe("server_vad");

  mock.deliver({ type: "session.updated", session: { id: "sess_1" } });
  const session = await sessionPromise;
  expect(session).toBeTruthy();
});

test("OpenAIRealtimeProvider: audio frames upstream are base64-encoded into input_audio_buffer.append", async () => {
  const provider = new OpenAIRealtimeProvider({ wsFactory: () => mock as any });
  const events = makeEvents();
  const sessionPromise = provider.startSession(baseConfig, events);
  mock.fireOpen();
  await mock.waitForSentMessages(1);
  mock.deliver({ type: "session.updated", session: { id: "sess_1" } });
  const session = await sessionPromise;

  const frame = new Uint8Array([1, 2, 3, 4]).buffer;
  session.sendAudio({ pcm: frame, sampleRate: 24000, channels: 1 });

  await mock.waitForSentMessages(2);
  const sent = JSON.parse(mock.sent[1]);
  expect(sent.type).toBe("input_audio_buffer.append");
  expect(typeof sent.audio).toBe("string");
  expect(sent.audio).toBe("AQIDBA==");
});

test("OpenAIRealtimeProvider: response.output_audio.delta surfaces as onAudio frame", async () => {
  const provider = new OpenAIRealtimeProvider({ wsFactory: () => mock as any });
  const events = makeEvents();
  const sessionPromise = provider.startSession(baseConfig, events);
  mock.fireOpen();
  await mock.waitForSentMessages(1);
  mock.deliver({ type: "session.updated", session: { id: "sess_1" } });
  await sessionPromise;

  mock.deliver({ type: "response.output_audio.delta", delta: "aGVsbG8=" });
  const audioEvent = events.received.find((r) => r.kind === "audio");
  expect(audioEvent).toBeTruthy();
  expect(new Uint8Array(audioEvent.frame.pcm)).toEqual(new Uint8Array([104, 101, 108, 108, 111]));
});

test("OpenAIRealtimeProvider: function_call_arguments.done surfaces as onToolCall", async () => {
  const provider = new OpenAIRealtimeProvider({ wsFactory: () => mock as any });
  const events = makeEvents();
  const sessionPromise = provider.startSession(baseConfig, events);
  mock.fireOpen();
  await mock.waitForSentMessages(1);
  mock.deliver({ type: "session.updated", session: { id: "sess_1" } });
  await sessionPromise;

  mock.deliver({
    type: "response.function_call_arguments.done",
    call_id: "call_1",
    name: "list_projects",
    arguments: "{}"
  });
  const toolEvent = events.received.find((r) => r.kind === "tool");
  expect(toolEvent).toBeTruthy();
  expect(toolEvent.call.callId).toBe("call_1");
  expect(toolEvent.call.name).toBe("list_projects");
  expect(toolEvent.call.args).toEqual({});
});

test("OpenAIRealtimeProvider: sendToolResult sends function_call_output + response.create", async () => {
  const provider = new OpenAIRealtimeProvider({ wsFactory: () => mock as any });
  const events = makeEvents();
  const sessionPromise = provider.startSession(baseConfig, events);
  mock.fireOpen();
  await mock.waitForSentMessages(1);
  mock.deliver({ type: "session.updated", session: { id: "sess_1" } });
  const session = await sessionPromise;

  session.sendToolResult("call_1", { result: { projects: [] } });
  await mock.waitForSentMessages(3);
  const itemMsg = JSON.parse(mock.sent[1]);
  expect(itemMsg.type).toBe("conversation.item.create");
  expect(itemMsg.item.type).toBe("function_call_output");
  expect(itemMsg.item.call_id).toBe("call_1");
  expect(JSON.parse(itemMsg.item.output)).toEqual({ projects: [] });

  const responseMsg = JSON.parse(mock.sent[2]);
  expect(responseMsg.type).toBe("response.create");
});

test("OpenAIRealtimeProvider: sendContextMessage sends text item + response.create", async () => {
  const provider = new OpenAIRealtimeProvider({ wsFactory: () => mock as any });
  const events = makeEvents();
  const sessionPromise = provider.startSession(baseConfig, events);
  mock.fireOpen();
  await mock.waitForSentMessages(1);
  mock.deliver({ type: "session.updated", session: { id: "sess_1" } });
  const session = await sessionPromise;

  session.sendContextMessage("[Mandate background task completed]\nResult: done");

  await mock.waitForSentMessages(3);
  const itemMsg = JSON.parse(mock.sent[1]);
  expect(itemMsg.type).toBe("conversation.item.create");
  expect(itemMsg.item.type).toBe("message");
  expect(itemMsg.item.role).toBe("user");
  expect(itemMsg.item.content).toEqual([{
    type: "input_text",
    text: "[Mandate background task completed]\nResult: done"
  }]);

  const responseMsg = JSON.parse(mock.sent[2]);
  expect(responseMsg.type).toBe("response.create");
});

test("OpenAIRealtimeProvider: invalid api key surfaces as auth error", async () => {
  const provider = new OpenAIRealtimeProvider({ wsFactory: () => mock as any });
  const events = makeEvents();
  const promise = provider.startSession(baseConfig, events).catch((e) => e);
  mock.fireOpen();
  await mock.waitForSentMessages(1);
  mock.deliver({
    type: "error",
    error: { code: "invalid_request_error", message: "Incorrect API key" }
  });
  const err = await promise;
  expect(err).toBeInstanceOf(Error);
  expect(err.message).toContain("auth");
});

test("OpenAIRealtimeProvider: 'active response in progress' protocol noise is swallowed (not surfaced as onError)", async () => {
  const provider = new OpenAIRealtimeProvider({ wsFactory: () => mock as any });
  const events = makeEvents();
  const sessionPromise = provider.startSession(baseConfig, events);
  mock.fireOpen();
  await mock.waitForSentMessages(1);
  mock.deliver({ type: "session.updated", session: { id: "sess_1" } });
  await sessionPromise;

  // Simulate the realtime API's response when we fire response.create while
  // the prior response is still streaming (after a tool result, while audio
  // is still playing).
  mock.deliver({
    type: "error",
    error: {
      type: "invalid_request_error",
      code: "conversation_already_has_active_response",
      message: "Conversation already has an active response in progress: resp_abc123. Wait until the response is finished before creating a new one."
    }
  });

  const errorEvents = events.received.filter((r: any) => r.kind === "error");
  expect(errorEvents).toHaveLength(0);
});

test("OpenAIRealtimeProvider: other protocol errors still surface as onError", async () => {
  const provider = new OpenAIRealtimeProvider({ wsFactory: () => mock as any });
  const events = makeEvents();
  const sessionPromise = provider.startSession(baseConfig, events);
  mock.fireOpen();
  await mock.waitForSentMessages(1);
  mock.deliver({ type: "session.updated", session: { id: "sess_1" } });
  await sessionPromise;

  mock.deliver({
    type: "error",
    error: { type: "server_error", message: "Internal server error" }
  });

  const errorEvents = events.received.filter((r: any) => r.kind === "error");
  expect(errorEvents).toHaveLength(1);
  expect(errorEvents[0].err).toMatchObject({ kind: "protocol", message: "Internal server error" });
});

test("OpenAIRealtimeProvider: ws error+close during handshake rejects without firing onError", async () => {
  const provider = new OpenAIRealtimeProvider({ wsFactory: () => mock as any });
  const events = makeEvents();
  const promise = provider.startSession(baseConfig, events).catch((e) => e);
  mock.fireOpen();
  await mock.waitForSentMessages(1);
  // Simulate real WS failure: onerror followed by onclose
  mock.fireErrorAndClose(new Error("ECONNREFUSED"));
  const err = await promise;
  expect(err).toBeInstanceOf(Error);
  expect(err.message).toContain("network");
  // Critically: no onError callback should have fired (handshake settled via reject)
  const errorEvents = events.received.filter((r: any) => r.kind === "error");
  expect(errorEvents).toHaveLength(0);
});

test("OpenAIRealtimeProvider: Azure GA mode uses api-key header + model query param", async () => {
  let capturedUrl = "";
  let capturedHeaders: Record<string, string> = {};
  const provider = new OpenAIRealtimeProvider({
    baseURL: "wss://my-resource.openai.azure.com/openai/v1/realtime",
    deployment: "gpt-realtime-deploy",
    wsFactory: (url, headers) => {
      capturedUrl = url;
      capturedHeaders = headers;
      return mock as any;
    }
  });
  const events = makeEvents();
  const sessionPromise = provider.startSession(baseConfig, events);
  mock.fireOpen();
  await mock.waitForSentMessages(1);
  mock.deliver({ type: "session.updated", session: { id: "sess_1" } });
  await sessionPromise;

  expect(capturedUrl).toContain("my-resource.openai.azure.com");
  expect(capturedUrl).toContain("/openai/v1/realtime");
  expect(capturedUrl).toContain("model=gpt-realtime-deploy");
  expect(capturedHeaders["api-key"]).toBe("sk-test");
  expect(capturedHeaders.Authorization).toBeUndefined();
});

test("OpenAIRealtimeProvider: Azure mode falls back to model name when deployment unset", async () => {
  let capturedUrl = "";
  const provider = new OpenAIRealtimeProvider({
    baseURL: "wss://my-resource.openai.azure.com/openai/v1/realtime",
    wsFactory: (url) => { capturedUrl = url; return mock as any; }
  });
  const events = makeEvents();
  const sessionPromise = provider.startSession(baseConfig, events);
  mock.fireOpen();
  await mock.waitForSentMessages(1);
  mock.deliver({ type: "session.updated", session: { id: "sess_1" } });
  await sessionPromise;

  // No explicit deployment → uses config.model "gpt-realtime-mini"
  expect(capturedUrl).toContain("model=gpt-realtime-mini");
});

test("OpenAIRealtimeProvider: default OpenAI mode uses Bearer auth + model query param", async () => {
  let capturedUrl = "";
  let capturedHeaders: Record<string, string> = {};
  const provider = new OpenAIRealtimeProvider({
    wsFactory: (url, headers) => {
      capturedUrl = url;
      capturedHeaders = headers;
      return mock as any;
    }
  });
  const events = makeEvents();
  const sessionPromise = provider.startSession(baseConfig, events);
  mock.fireOpen();
  await mock.waitForSentMessages(1);
  mock.deliver({ type: "session.updated", session: { id: "sess_1" } });
  await sessionPromise;

  expect(capturedUrl).toContain("api.openai.com");
  expect(capturedUrl).toContain("model=gpt-realtime-mini");
  expect(capturedHeaders.Authorization).toBe("Bearer sk-test");
  expect(capturedHeaders["api-key"]).toBeUndefined();
});

test("OpenAIRealtimeProvider: preloadHistory sends conversation.item.create per item", async () => {
  const provider = new OpenAIRealtimeProvider({ wsFactory: () => mock as any });
  const events = makeEvents();
  const sessionPromise = provider.startSession(baseConfig, events);
  mock.fireOpen();
  await mock.waitForSentMessages(1);
  mock.deliver({ type: "session.updated", session: { id: "sess_1" } });
  const session = await sessionPromise;

  session.preloadHistory([
    { role: "user", text: "hello" },
    { role: "assistant", text: "hi there" }
  ]);

  await mock.waitForSentMessages(3); // 1 session.update + 2 preload items
  const userItem = JSON.parse(mock.sent[1]);
  expect(userItem.type).toBe("conversation.item.create");
  expect(userItem.item.type).toBe("message");
  expect(userItem.item.role).toBe("user");
  expect(userItem.item.content).toEqual([{ type: "input_text", text: "hello" }]);

  const assistantItem = JSON.parse(mock.sent[2]);
  expect(assistantItem.type).toBe("conversation.item.create");
  expect(assistantItem.item.type).toBe("message");
  expect(assistantItem.item.role).toBe("assistant");
  expect(assistantItem.item.content).toEqual([{ type: "output_text", text: "hi there" }]);
});
