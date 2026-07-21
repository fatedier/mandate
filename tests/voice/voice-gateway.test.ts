import { expect, test } from "bun:test";
import { VoiceSessionGateway } from "../../src/server/modules/voice/voice-gateway.js";

type FakeHandler = (payload?: unknown) => void;

class FakeOrchestrator {
  handlers = new Map<string, FakeHandler[]>();
  started = false;
  audioFrames: Array<{ pcm: ArrayBuffer; sampleRate: number; channels: number }> = [];
  cancelCount = 0;
  uiLocations: unknown[] = [];
  closeReasons: string[] = [];

  on(event: string, handler: FakeHandler) {
    const list = this.handlers.get(event) ?? [];
    list.push(handler);
    this.handlers.set(event, list);
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

  setUiLocation(location: unknown) {
    this.uiLocations.push(location);
  }

  async close(reason = "client-closed") {
    this.closeReasons.push(reason);
    this.emit("onClose", reason);
  }
}

test("VoiceSessionGateway opens a session and routes client messages to the orchestrator", async () => {
  const orch = new FakeOrchestrator();
  const gateway = new VoiceSessionGateway({ buildOrchestrator: () => orch as any });
  const ws = fakeWs();
  const handlers = gateway.createHandlers();

  await handlers.onOpen({}, ws as any);
  expect(orch.started).toBe(true);
  expect(ws.messages).toEqual([{ type: "ready" }]);

  handlers.onMessage({
    data: JSON.stringify({
      type: "audio",
      pcm: btoa(String.fromCharCode(1, 2, 3)),
      sampleRate: 16000
    })
  });
  handlers.onMessage({ data: JSON.stringify({ type: "cancel" }) });
  handlers.onMessage({
    data: JSON.stringify({
      type: "ui_location",
      uiLocation: {
        clientId: "client-1",
        path: "/sessions",
        routeKind: "sessions"
      }
    })
  });

  expect(new Uint8Array(orch.audioFrames[0]!.pcm)).toEqual(new Uint8Array([1, 2, 3]));
  expect(orch.audioFrames[0]!.sampleRate).toBe(16000);
  expect(orch.audioFrames[0]!.channels).toBe(1);
  expect(orch.cancelCount).toBe(1);
  expect(orch.uiLocations[0]).toMatchObject({
    clientId: "client-1",
    path: "/sessions",
    routeKind: "sessions"
  });
});

test("VoiceSessionGateway forwards orchestrator events to the websocket", async () => {
  const orch = new FakeOrchestrator();
  const gateway = new VoiceSessionGateway({ buildOrchestrator: () => orch as any });
  const ws = fakeWs();
  const handlers = gateway.createHandlers();

  await handlers.onOpen({}, ws as any);
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
      return orch as any;
    }
  });

  const first = gateway.createHandlers();
  const second = gateway.createHandlers();
  const ws1 = fakeWs();
  const ws2 = fakeWs();

  await first.onOpen({}, ws1 as any);
  await second.onOpen({}, ws2 as any);

  expect(ws1.messages).toContainEqual({ type: "superseded" });
  expect(ws1.closed).toContainEqual({ code: 1000, reason: "superseded" });
  expect(orchestrators[0]!.closeReasons).toContain("superseded");
  expect(ws2.messages).toEqual([{ type: "ready" }]);
});

test("VoiceSessionGateway reports startup failures", async () => {
  const gateway = new VoiceSessionGateway({
    buildOrchestrator: () => ({
      on: () => {},
      start: async () => { throw new Error("no voice"); }
    }) as any
  });
  const ws = fakeWs();

  await gateway.createHandlers().onOpen({}, ws as any);

  expect(ws.messages).toEqual([{ type: "error", message: "no voice" }]);
  expect(ws.closed).toEqual([{ code: 1011, reason: "no voice" }]);
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
