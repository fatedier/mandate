import { expect, test, beforeEach } from "bun:test";
import { z } from "zod";
import { createMockWebSocket, type MockWebSocket } from "./helpers/mock-ws.js";
import { OpenAIRealtimeProvider, toRealtimeFunctionSchema } from "../../src/server/modules/voice/openai-realtime-provider.js";
import { CodexRealtimeProvider } from "../../src/server/modules/voice/codex-realtime-provider.js";
import { CODEX_USER_AGENT } from "../../src/server/modules/codex/codex-http.js";
import type { VoiceSessionEvents, VoiceProviderConfig } from "../../src/server/modules/voice/voice-provider.js";
import type { ToolDefinition } from "../../src/server/modules/agent/tool-registry.js";
import { waitUntil } from "../helpers/wait.js";

let mock: MockWebSocket;

beforeEach(() => {
  mock = createMockWebSocket();
});

function makeEvents(): VoiceSessionEvents & { received: any[] } {
  const received: any[] = [];
  return {
    received,
    onAudio: (f) => received.push({ kind: "audio", frame: f }),
    onTranscript: (d, source) => received.push({ kind: "transcript", delta: d, source }),
    onToolCall: (c) => received.push({ kind: "tool", call: c }),
    onSpeechStarted: () => received.push({ kind: "speech-started" }),
    onSpeechStopped: () => received.push({ kind: "speech-stopped" }),
    onResponseCreated: (info) => received.push({ kind: "response-created", info }),
    onResponseItemAdded: (info) => received.push({ kind: "response-item-added", info }),
    onResponseDone: (info) => received.push({ kind: "response-done", info }),
    onResponseRejected: (why) => received.push({ kind: "response-rejected", why }),
    onError: (e) => received.push({ kind: "error", err: e }),
    onClose: () => received.push({ kind: "close" })
  };
}

const FAKE_TOOLS: ToolDefinition[] = [{
  name: "list_projects",
  description: "List",
  parameters: z.object({}),
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
  const provider = new OpenAIRealtimeProvider({ wsFactory: () => mock });
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
  const provider = new OpenAIRealtimeProvider({ wsFactory: () => mock });
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
  const provider = new OpenAIRealtimeProvider({ wsFactory: () => mock });
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
  const provider = new OpenAIRealtimeProvider({ wsFactory: () => mock });
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

test("OpenAIRealtimeProvider: sendToolResult adds the function_call_output and asks for no response", async () => {
  const provider = new OpenAIRealtimeProvider({ wsFactory: () => mock });
  const events = makeEvents();
  const sessionPromise = provider.startSession(baseConfig, events);
  mock.fireOpen();
  await mock.waitForSentMessages(1);
  mock.deliver({ type: "session.updated", session: { id: "sess_1" } });
  const session = await sessionPromise;

  session.sendToolResult("call_1", { result: { projects: [] } });
  await mock.waitForSentMessages(2);
  const itemMsg = JSON.parse(mock.sent[1]);
  expect(itemMsg.type).toBe("conversation.item.create");
  expect(itemMsg.item.type).toBe("function_call_output");
  expect(itemMsg.item.call_id).toBe("call_1");
  expect(JSON.parse(itemMsg.item.output)).toEqual({ projects: [] });
  await Bun.sleep(5);
  expect(mock.sent).toHaveLength(2);
});

test("OpenAIRealtimeProvider: sendContextMessage adds a user text item and asks for no response", async () => {
  const provider = new OpenAIRealtimeProvider({ wsFactory: () => mock });
  const events = makeEvents();
  const sessionPromise = provider.startSession(baseConfig, events);
  mock.fireOpen();
  await mock.waitForSentMessages(1);
  mock.deliver({ type: "session.updated", session: { id: "sess_1" } });
  const session = await sessionPromise;

  session.sendContextMessage("[Mandate background task completed]\nResult: done");

  await mock.waitForSentMessages(2);
  const itemMsg = JSON.parse(mock.sent[1]);
  expect(itemMsg.type).toBe("conversation.item.create");
  expect(itemMsg.item.type).toBe("message");
  expect(itemMsg.item.role).toBe("user");
  expect(itemMsg.item.content).toEqual([{
    type: "input_text",
    text: "[Mandate background task completed]\nResult: done"
  }]);
  await Bun.sleep(5);
  expect(mock.sent).toHaveLength(2);
});

test("OpenAIRealtimeProvider: invalid api key surfaces as auth error", async () => {
  const provider = new OpenAIRealtimeProvider({ wsFactory: () => mock });
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

test("OpenAIRealtimeProvider: 'active response in progress' is a refused response.create for the session, not an error", async () => {
  const provider = new OpenAIRealtimeProvider({ wsFactory: () => mock });
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
  expect(events.received.at(-1)).toEqual({ kind: "response-rejected", why: "busy" });
});

test("OpenAIRealtimeProvider: ws error+close during handshake rejects without firing onError", async () => {
  const provider = new OpenAIRealtimeProvider({ wsFactory: () => mock });
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

// Which URL and auth each connection mode uses. auth lists both headers; an
// undefined one must be absent.
const connectionModes: {
  name: string;
  options: { baseURL?: string; deployment?: string };
  urlParts: string[];
  auth: { "api-key": string | undefined; Authorization: string | undefined };
}[] = [
  {
    name: "Azure GA mode uses api-key header + model query param",
    options: { baseURL: "wss://my-resource.openai.azure.com/openai/v1/realtime", deployment: "gpt-realtime-deploy" },
    urlParts: ["my-resource.openai.azure.com", "/openai/v1/realtime", "model=gpt-realtime-deploy"],
    auth: { "api-key": "sk-test", Authorization: undefined }
  },
  {
    // No explicit deployment → uses config.model "gpt-realtime-mini"
    name: "Azure mode falls back to model name when deployment unset",
    options: { baseURL: "wss://my-resource.openai.azure.com/openai/v1/realtime" },
    urlParts: ["model=gpt-realtime-mini"],
    auth: { "api-key": "sk-test", Authorization: undefined }
  },
  {
    name: "default OpenAI mode uses Bearer auth + model query param",
    options: {},
    urlParts: ["api.openai.com", "model=gpt-realtime-mini"],
    auth: { "api-key": undefined, Authorization: "Bearer sk-test" }
  }
];

test.each(connectionModes)("OpenAIRealtimeProvider: $name", async ({ options, urlParts, auth }) => {
  let capturedUrl = "";
  let capturedHeaders: Record<string, string | undefined> = {};
  const provider = new OpenAIRealtimeProvider({
    ...options,
    wsFactory: (url, headers) => {
      capturedUrl = url;
      capturedHeaders = headers;
      return mock;
    }
  });
  const events = makeEvents();
  const sessionPromise = provider.startSession(baseConfig, events);
  mock.fireOpen();
  await mock.waitForSentMessages(1);
  mock.deliver({ type: "session.updated", session: { id: "sess_1" } });
  await sessionPromise;

  for (const part of urlParts) expect(capturedUrl).toContain(part);
  expect({ "api-key": capturedHeaders["api-key"], Authorization: capturedHeaders.Authorization }).toEqual(auth);
});

test("OpenAIRealtimeProvider: preloadHistory sends conversation.item.create per item", async () => {
  const provider = new OpenAIRealtimeProvider({ wsFactory: () => mock });
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

test("toRealtimeFunctionSchema: translates ToolDefinition to OpenAI function schema", () => {
  const def: ToolDefinition = {
    name: "list_features",
    description: "List features in a project",
    parameters: z.object({ projectId: z.string().describe("The project ID") }),
    handler: async () => ({})
  };
  const schema = toRealtimeFunctionSchema(def);
  expect(schema.type).toBe("function");
  expect(schema.name).toBe("list_features");
  expect(schema.description).toBe("List features in a project");
  const parameters = schema.parameters as { type: string; properties: Record<string, { type: string }>; required: string[] };
  expect(parameters.type).toBe("object");
  expect(parameters.properties.projectId.type).toBe("string");
  expect(parameters.required).toContain("projectId");
});

test("OpenAIRealtimeProvider: new instructions go out as a session.update; speech_stopped reaches the session", async () => {
  const provider = new OpenAIRealtimeProvider({ wsFactory: () => mock });
  const events = makeEvents();
  const sessionPromise = provider.startSession(baseConfig, events);
  mock.fireOpen();
  await mock.waitForSentMessages(1);
  mock.deliver({ type: "session.updated", session: { id: "sess_1" } });
  const session = await sessionPromise;
  session.updateInstructions("BASE\n\nctx-2");
  await mock.waitForSentMessages(2);
  expect(JSON.parse(mock.sent[1]!)).toEqual({ type: "session.update", session: { type: "realtime", instructions: "BASE\n\nctx-2" } });
  mock.deliver({ type: "input_audio_buffer.speech_stopped" });
  expect(events.received.at(-1)).toEqual({ kind: "speech-stopped" });
});

test("OpenAIRealtimeProvider: requestResponse carries its tag and tool choice; a bare one stays bare", async () => {
  const provider = new OpenAIRealtimeProvider({ wsFactory: () => mock });
  const sessionPromise = provider.startSession(baseConfig, makeEvents());
  mock.fireOpen();
  await mock.waitForSentMessages(1);
  mock.deliver({ type: "session.updated", session: { id: "sess_1" } });
  const session = await sessionPromise;
  session.requestResponse({ metadata: { mandate: "update" }, toolChoice: "none" });
  session.requestResponse({ metadata: { mandate: "continuation" } });
  session.requestResponse();
  await mock.waitForSentMessages(4);
  const sent = mock.sent.slice(1).map((raw) => JSON.parse(raw!) as Record<string, unknown> & { event_id: string });
  expect(sent).toStrictEqual([
    { type: "response.create", event_id: sent[0]!.event_id, response: { metadata: { mandate: "update" }, tool_choice: "none" } },
    { type: "response.create", event_id: sent[1]!.event_id, response: { metadata: { mandate: "continuation" } } },
    { type: "response.create", event_id: sent[2]!.event_id }
  ]);
  expect(new Set(sent.map((e) => e.event_id)).size).toBe(3);
});

test("OpenAIRealtimeProvider: an error our response.create caused refuses that request, and still surfaces; one another event caused only surfaces", async () => {
  const provider = new OpenAIRealtimeProvider({ wsFactory: () => mock });
  const events = makeEvents();
  const sessionPromise = provider.startSession(baseConfig, events);
  mock.fireOpen();
  await mock.waitForSentMessages(1);
  mock.deliver({ type: "session.updated", session: { id: "sess_1" } });
  const session = await sessionPromise;
  session.requestResponse({ metadata: { mandate: "update" }, toolChoice: "none" });
  await mock.waitForSentMessages(2);
  const request = JSON.parse(mock.sent[1]!) as { event_id: string };
  const before = events.received.length;
  mock.deliver({ type: "error", error: { type: "invalid_request_error", code: "rate_limit_exceeded", message: "Rate limit reached", event_id: request.event_id } });
  mock.deliver({ type: "error", error: { type: "server_error", message: "Internal server error", event_id: "evt_other" } });
  expect(events.received.slice(before).map((r: any) => r.kind === "error" ? `error ${r.err.kind}: ${r.err.message}` : `${r.kind} (${r.why})`)).toEqual([
    "response-rejected (error)", "error protocol: Rate limit reached", "error protocol: Internal server error"
  ]);
});

test("OpenAIRealtimeProvider: response events, transcripts and tool calls carry their response", async () => {
  const provider = new OpenAIRealtimeProvider({ wsFactory: () => mock });
  const events = makeEvents();
  const sessionPromise = provider.startSession(baseConfig, events);
  mock.fireOpen();
  await mock.waitForSentMessages(1);
  mock.deliver({ type: "session.updated", session: { id: "sess_1" } });
  await sessionPromise;
  mock.deliver({ type: "response.created", response: { id: "resp_1", status: "in_progress", metadata: { mandate: "update" } } });
  mock.deliver({ type: "response.output_audio_transcript.done", response_id: "resp_1", transcript: "release replied." });
  mock.deliver({ type: "response.function_call_arguments.done", response_id: "resp_1", call_id: "call_1", name: "waiting_on_you", arguments: "{}" });
  mock.deliver({ type: "response.done", response: { id: "resp_1", status: "cancelled" } });
  mock.deliver({ type: "response.created", response: { id: "resp_2", status: "in_progress", metadata: null } });
  expect(events.received.map((r: any) => r.info ?? r.source ?? r.call?.responseId)).toEqual([
    { responseId: "resp_1", metadata: { mandate: "update" } },
    { responseId: "resp_1" },
    "resp_1",
    { responseId: "resp_1", status: "cancelled" },
    { responseId: "resp_2", metadata: null }
  ]);
});

/** How an opening ended, or that it had not within `ms` (a missing deadline
 *  fails the test instead of hanging the run). */
function outcomeWithin(opening: Promise<unknown>, ms = 500): Promise<string> {
  return Promise.race([
    opening.then(() => "opened", (err: unknown) => `rejected: ${err instanceof Error ? err.message : String(err)}`),
    Bun.sleep(ms).then(() => "still pending")
  ]);
}

test("OpenAIRealtimeProvider: an opening the provider refuses closes its socket", async () => {
  const provider = new OpenAIRealtimeProvider({ wsFactory: () => mock });
  const events = makeEvents();
  const opening = provider.startSession(baseConfig, events);
  mock.fireOpen();
  await mock.waitForSentMessages(1);
  mock.deliver({ type: "error", error: { code: "rate_limit_exceeded", message: "slow down" } });
  expect(await outcomeWithin(opening)).toBe("rejected: rate-limit: slow down");
  expect(mock.readyState).toBe(3);
});

test("OpenAIRealtimeProvider: an opening that does not answer in time is given up, closed, and stays silent", async () => {
  const provider = new OpenAIRealtimeProvider({ wsFactory: () => mock, handshakeTimeoutMs: 20 });
  const events = makeEvents();
  const opening = provider.startSession(baseConfig, events);
  mock.fireOpen();
  expect(await outcomeWithin(opening)).toContain("did not answer");
  expect(mock.readyState).toBe(3);
  mock.deliver({ type: "session.updated", session: { id: "late" } });
  mock.fireClose(1000, "bye");
  expect(events.received).toStrictEqual([]);
});

test("OpenAIRealtimeProvider: an aborted opening is closed", async () => {
  const provider = new OpenAIRealtimeProvider({ wsFactory: () => mock });
  const controller = new AbortController();
  const opening = provider.startSession(baseConfig, makeEvents(), controller.signal);
  mock.fireOpen();
  await mock.waitForSentMessages(1);
  controller.abort();
  expect(await outcomeWithin(opening)).toContain("cancelled");
  expect(mock.readyState).toBe(3);
});

test("OpenAIRealtimeProvider: an opening cancelled while its credentials resolve opens no socket", async () => {
  let sockets = 0;
  let resolveHeaders!: (headers: Record<string, string>) => void;
  const provider = new OpenAIRealtimeProvider({
    wsFactory: () => { sockets += 1; return mock; },
    resolveAuthHeaders: () => new Promise((resolve) => { resolveHeaders = resolve; })
  });
  const controller = new AbortController();
  const opening = provider.startSession(baseConfig, makeEvents(), controller.signal);
  controller.abort();
  expect(await outcomeWithin(opening)).toContain("cancelled");
  resolveHeaders({ Authorization: "Bearer t" });
  await Bun.sleep(5);
  expect(sockets).toBe(0);
});

test("OpenAIRealtimeProvider: a cancel that lands just after the credentials resolve still opens no socket", async () => {
  let sockets = 0;
  let resolveHeaders!: (headers: Record<string, string>) => void;
  const provider = new OpenAIRealtimeProvider({
    wsFactory: () => { sockets += 1; return mock; },
    resolveAuthHeaders: () => new Promise((resolve) => { resolveHeaders = resolve; })
  });
  const controller = new AbortController();
  const opening = provider.startSession(baseConfig, makeEvents(), controller.signal);
  await Bun.sleep(1);
  resolveHeaders({ Authorization: "Bearer t" });
  queueMicrotask(() => controller.abort()); // before the opening resumes
  expect(await outcomeWithin(opening)).toContain("cancelled");
  expect(sockets).toBe(0);
});

test("OpenAIRealtimeProvider: an opening cancelled before it starts asks for no credentials", async () => {
  let asked = 0;
  const provider = new OpenAIRealtimeProvider({
    wsFactory: () => mock,
    resolveAuthHeaders: () => { asked += 1; return Promise.reject(new Error("codex: no stored login")); }
  });
  const controller = new AbortController();
  controller.abort();
  expect(await outcomeWithin(provider.startSession(baseConfig, makeEvents(), controller.signal))).toContain("cancelled");
  expect(asked).toBe(0);
});

// The Codex provider opens the same realtime socket with the ChatGPT sign-in.
const codexConfig: VoiceProviderConfig = {
  providerName: "codex",
  providerType: "codex",
  apiKey: "",
  model: "gpt-realtime-1.5",
  voice: "marin",
  language: "auto",
  systemPrompt: "You are the voice agent.",
  tools: FAKE_TOOLS
};

test("CodexRealtimeProvider: uses Codex OAuth headers on OpenAI realtime websocket", async () => {
  const mock = createMockWebSocket();
  let capturedUrl = "";
  let capturedHeaders: Record<string, string> = {};
  const provider = new CodexRealtimeProvider({
    resolveAccess: async () => ({
      providerName: "codex",
      providerType: "codex",
      type: "oauth",
      access: "access-token",
      refresh: "refresh-token",
      expiresAt: Date.now() + 3600_000,
      accountId: "acct_test",
      updatedAt: new Date().toISOString()
    }),
    wsFactory: (url, headers) => {
      capturedUrl = url;
      capturedHeaders = headers;
      return mock;
    }
  });

  const sessionPromise = provider.startSession(codexConfig, makeEvents());
  await waitUntil(() => capturedUrl, { timeout: 1000, label: "the provider opens its websocket" });
  mock.fireOpen();
  await mock.waitForSentMessages(1);
  mock.deliver({ type: "session.updated", session: { id: "sess_1" } });
  await sessionPromise;

  expect(capturedUrl).toBe("wss://api.openai.com/v1/realtime?model=gpt-realtime-1.5");
  expect(capturedHeaders.Authorization).toBe("Bearer access-token");
  expect(capturedHeaders["ChatGPT-Account-Id"]).toBe("acct_test");
  expect(capturedHeaders["User-Agent"]).toBe(CODEX_USER_AGENT);
  expect(capturedHeaders.originator).toBe("mandate");
  expect(capturedHeaders["api-key"]).toBeUndefined();

  const sessionUpdate = JSON.parse(mock.sent[0]);
  expect(sessionUpdate.session.model).toBe("gpt-realtime-1.5");
  expect(sessionUpdate.session.audio.output.voice).toBe("marin");
});

test("CodexRealtimeProvider: requires a provider name", async () => {
  const provider = new CodexRealtimeProvider({
    resolveAccess: async () => {
      throw new Error("should not be called");
    },
    wsFactory: () => createMockWebSocket()
  });

  const promise = provider.startSession({ ...codexConfig, providerName: "" }, makeEvents()).catch((err) => err);
  const err = await promise;
  expect(err).toBeInstanceOf(Error);
  expect(err.message).toContain("provider name");
});
