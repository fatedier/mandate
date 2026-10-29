import { expect, test } from "bun:test";
import type { WSContext } from "hono/ws";
import { VoiceSessionGateway } from "../../src/server/modules/voice/voice-gateway.js";
import type { VoiceSessionOrchestrator } from "../../src/server/modules/voice/voice-session-orchestrator.js";
import { stub } from "../helpers/typed.js";
import { VOICE_CLIENT_MESSAGES } from "../../src/shared/api-contracts.js";

type FakeHandler = (payload?: unknown) => void;

/** The part of an orchestrator the gateway drives. */
type DrivenOrchestrator = Pick<VoiceSessionOrchestrator, "on" | "start" | "sendAudio" | "cancelResponse" | "close">;

class FakeOrchestrator implements DrivenOrchestrator {
  handlers = new Map<string, FakeHandler[]>();
  started = false;
  audioFrames: Array<{ pcm: ArrayBuffer; sampleRate: number; channels: number }> = [];
  cancelCount = 0;
  closeReasons: string[] = [];

  on(event: string, handler: FakeHandler) {
    const list = this.handlers.get(event) ?? [];
    list.push(handler);
    this.handlers.set(event, list);
    return () => { this.handlers.set(event, (this.handlers.get(event) ?? []).filter((h) => h !== handler)); };
  }

  emit(event: string, payload?: unknown) {
    for (const handler of this.handlers.get(event) ?? []) {
      handler(payload);
    }
  }

  async start() {
    this.started = true;
  }

  sendAudio(frame: { pcm: ArrayBuffer; sampleRate: number; channels: number }) {
    this.audioFrames.push(frame);
  }

  cancelResponse() {
    this.cancelCount += 1;
  }

  async close(reason = "client-closed") {
    this.closeReasons.push(reason);
    this.emit("onClose", reason);
  }
}

test("VoiceSessionGateway opens a session and routes client messages to the orchestrator", async () => {
  const orch = new FakeOrchestrator();
  const gateway = new VoiceSessionGateway({ buildOrchestrator: () => stub<VoiceSessionOrchestrator>(orch) });
  const ws = fakeWs();
  const handlers = gateway.createHandlers();

  await handlers.onOpen({}, stub<WSContext>(ws));
  expect(orch.started).toBe(true);
  expect(ws.messages).toStrictEqual([{ type: "ready" }]);

  handlers.onMessage({
    data: JSON.stringify({
      type: "audio",
      pcm: btoa(String.fromCharCode(1, 2, 3)),
      sampleRate: 16000
    })
  });
  handlers.onMessage({ data: JSON.stringify({ type: "cancel" }) });

  expect(new Uint8Array(orch.audioFrames[0]!.pcm)).toEqual(new Uint8Array([1, 2, 3]));
  expect(orch.audioFrames[0]!.sampleRate).toBe(16000);
  expect(orch.audioFrames[0]!.channels).toBe(1);
  expect(orch.cancelCount).toBe(1);
});

test("VoiceSessionGateway forwards orchestrator events to the websocket", async () => {
  const orch = new FakeOrchestrator();
  const gateway = new VoiceSessionGateway({ buildOrchestrator: () => stub<VoiceSessionOrchestrator>(orch) });
  const ws = fakeWs();
  const handlers = gateway.createHandlers();

  await handlers.onOpen({}, stub<WSContext>(ws));
  orch.emit("onTranscript", { speaker: "user", text: "hello", isFinal: true });
  orch.emit("onSpeechStarted");
  orch.emit("onError", "boom");
  orch.emit("onAudio", {
    pcm: new Uint8Array([4, 5]).buffer,
    sampleRate: 24000,
    channels: 1
  });
  orch.emit("onClose", "done");

  expect(ws.messages).toContainEqual({
    type: "transcript",
    speaker: "user",
    text: "hello",
    isFinal: true
  });
  expect(ws.messages).toContainEqual({ type: "speech-started" });
  expect(ws.messages).toContainEqual({ type: "error", message: "boom" });
  expect(ws.messages).toContainEqual({
    type: "audio",
    pcm: btoa(String.fromCharCode(4, 5)),
    sampleRate: 24000,
    channels: 1
  });
  expect(ws.messages).toContainEqual({ type: "closed", reason: "done" });
  expect(ws.closed).toContainEqual({ code: 1000, reason: "done" });
});

test("VoiceSessionGateway supersedes the previous active session", async () => {
  const orchestrators: FakeOrchestrator[] = [];
  const gateway = new VoiceSessionGateway({
    buildOrchestrator: () => {
      const orch = new FakeOrchestrator();
      orchestrators.push(orch);
      return stub<VoiceSessionOrchestrator>(orch);
    }
  });

  const first = gateway.createHandlers();
  const second = gateway.createHandlers();
  const ws1 = fakeWs();
  const ws2 = fakeWs();

  await first.onOpen({}, stub<WSContext>(ws1));
  await second.onOpen({}, stub<WSContext>(ws2));

  expect(ws1.messages).toContainEqual({ type: "superseded" });
  expect(ws1.closed).toContainEqual({ code: 1000, reason: "superseded" });
  expect(orchestrators[0]!.closeReasons).toContain("superseded");
  expect(ws2.messages).toStrictEqual([{ type: "ready" }]);
});

test("a connection that closes while its session starts has that session closed, and a message sent meanwhile is dropped", async () => {
  const orch = new FakeOrchestrator();
  let release!: () => void;
  orch.start = () => new Promise<void>((resolve) => { release = () => { orch.started = true; resolve(); }; });
  const built = [orch, new FakeOrchestrator()];
  const gateway = new VoiceSessionGateway({ buildOrchestrator: () => stub<VoiceSessionOrchestrator>(built.shift()!) });
  const ws = fakeWs();
  const handlers = gateway.createHandlers();
  const opening = handlers.onOpen({}, stub<WSContext>(ws));
  await handlers.onMessage({ data: JSON.stringify({ type: VOICE_CLIENT_MESSAGES.cancel }) });
  await handlers.onClose();
  release();
  await opening;
  expect(orch.cancelCount).toBe(0);
  expect(orch.closeReasons).toStrictEqual(["client-closed"]);
  // It is not left as the active session: the next connection supersedes nothing.
  await gateway.createHandlers().onOpen({}, stub<WSContext>(fakeWs()));
  expect(ws.messages).not.toContainEqual({ type: "superseded" });
  expect(orch.closeReasons).toStrictEqual(["client-closed"]);
});

test("a reconnect, its end, and the limit that stopped voice reach the client", async () => {
  const orch = new FakeOrchestrator();
  const gateway = new VoiceSessionGateway({ buildOrchestrator: () => stub<VoiceSessionOrchestrator>(orch) });
  const ws = fakeWs();
  const handlers = gateway.createHandlers();
  await handlers.onOpen({}, stub<WSContext>(ws));
  orch.emit("onReconnecting");
  orch.emit("onResumed");
  expect(ws.messages.slice(-2)).toStrictEqual([{ type: "reconnecting" }, { type: "resumed" }]);
  for (const handler of orch.handlers.get("onClose") ?? []) (handler as (reason: string, afterMs?: number) => void)("idle-timeout", 300_000);
  expect(ws.messages.at(-1)).toEqual({ type: "closed", reason: "idle-timeout", afterMs: 300_000 });
});

test("a session whose voice service will not open stops voice with why, and ends its activation", async () => {
  const startedAt: number[] = [];
  let fail = true;
  const gateway = new VoiceSessionGateway({
    buildOrchestrator: (clocks) => {
      startedAt.push(clocks.startedAtMs);
      return stub<VoiceSessionOrchestrator>({
        on: () => () => {},
        start: async () => { if (fail) throw new Error("auth: Incorrect API key provided"); }
      });
    }
  });
  const ws = fakeWs();

  await gateway.createHandlers({ activationId: "act-1" }).onOpen({}, stub<WSContext>(ws));

  expect(ws.messages).toStrictEqual([{ type: "closed", reason: "provider-unavailable", message: "auth: Incorrect API key provided" }]);
  expect(ws.closed).toStrictEqual([{ code: 1000, reason: "provider-unavailable" }]);
  fail = false;
  await Bun.sleep(2);
  await gateway.createHandlers({ activationId: "act-1" }).onOpen({}, stub<WSContext>(fakeWs()));
  expect(startedAt[1]).toBeGreaterThan(startedAt[0]!);
});

function fakeWs() {
  return {
    messages: [] as unknown[],
    closed: [] as Array<{ code: number; reason: string }>,
    send(raw: string) {
      this.messages.push(JSON.parse(raw));
    },
    close(code: number, reason: string) {
      this.closed.push({ code, reason });
    }
  };
}
