import { expect, test } from "bun:test";
import { z } from "zod";
import { createMockWebSocket } from "./helpers/mock-ws.js";
import { CodexRealtimeProvider } from "../../src/server/modules/voice/codex-realtime-provider.js";
import { CODEX_USER_AGENT } from "../../src/server/modules/codex/codex-http.js";
import type { VoiceProviderConfig, VoiceSessionEvents } from "../../src/server/modules/voice/voice-provider.js";
import type { ToolDefinition } from "../../src/server/modules/agent/tool-registry.js";

function makeEvents(): VoiceSessionEvents {
  return {
    onAudio: () => {},
    onTranscript: () => {},
    onToolCall: () => {},
    onError: () => {},
    onClose: () => {},
    onSpeechStarted: () => {},
    onResponseCreated: () => {},
    onResponseItemAdded: () => {},
    onResponseDone: () => {}
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
      return mock as any;
    }
  });

  const sessionPromise = provider.startSession(baseConfig, makeEvents());
  await waitFor(() => Boolean(capturedUrl));
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
    wsFactory: () => createMockWebSocket() as any
  });

  const promise = provider.startSession({ ...baseConfig, providerName: "" }, makeEvents()).catch((err) => err);
  const err = await promise;
  expect(err).toBeInstanceOf(Error);
  expect(err.message).toContain("provider name");
});

async function waitFor(predicate: () => boolean) {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("timeout waiting for condition");
}
