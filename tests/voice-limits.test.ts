import { expect, test } from "bun:test";
import { z } from "zod";
import { freshAgentEnv } from "./helpers/fixtures.js";
import { waitUntil } from "./helpers/wait.js";
import { VoiceSessionOrchestrator, responseMetadata, type VoiceSessionOrchestratorDeps } from "../src/server/modules/voice/voice-session-orchestrator.js";
import type { VoiceProvider, VoiceSession, VoiceSessionEvents, VoiceProviderConfig } from "../src/server/modules/voice/voice-provider.js";
import { AgentSseEmitter } from "../src/server/modules/sse/sse-events.js";

class FakeProvider implements VoiceProvider {
  sessions: Array<{ config: VoiceProviderConfig; events: VoiceSessionEvents; preloaded: unknown[]; context: string[]; toolOutputs: string[]; instructions: string[] }> = [];
  failNext = 0;
  /** Runs while startSession is still pending (the caller's own close, say). */
  duringStart: (() => Promise<void> | void) | null = null;
  /** The next opening waits for this to be called (or for its abort). */
  holdNext = false;
  release: (() => void) | null = null;
  aborted = 0;
  startCalls = 0;
  /** Runs inside the next session's preload (it is installed, not yet resumed). */
  duringPreload: (() => void) | null = null;
  /** Runs when a session is closed by its caller. */
  onSessionClose: (() => Promise<void> | void) | null = null;
  async startSession(config: VoiceProviderConfig, events: VoiceSessionEvents, signal?: AbortSignal): Promise<VoiceSession> {
    this.startCalls += 1;
    if (this.failNext > 0) { this.failNext -= 1; throw new Error("network: refused"); }
    const record = { config, events, preloaded: [] as unknown[], context: [] as string[], toolOutputs: [] as string[], instructions: [] as string[] };
    this.sessions.push(record);
    if (this.holdNext) {
      this.holdNext = false;
      await new Promise<void>((resolve, reject) => {
        this.release = resolve;
        signal?.addEventListener("abort", () => { this.aborted += 1; reject(new Error("cancelled")); });
      });
    }
    const hook = this.duringStart;
    this.duringStart = null;
    await hook?.();
    return {
      sendAudio: () => {}, cancelResponse: () => {}, truncateItem: () => {},
      updateInstructions: (text) => { record.instructions.push(text); },
      requestResponse: () => {},
      // As the real socket does: closing it reports the close.
      close: async () => {
        const hook = this.onSessionClose;
        this.onSessionClose = null;
        await hook?.();
        events.onClose();
      },
      sendToolResult: (callId) => { record.toolOutputs.push(callId); },
      sendContextMessage: (text) => { record.context.push(text); },
      preloadHistory: (items) => {
        record.preloaded.push(...items);
        const hook = this.duringPreload;
        this.duringPreload = null;
        hook?.();
      }
    };
  }
  get last() { return this.sessions.at(-1)!; }
  instructionsFor(record: FakeProvider["sessions"][number]) { return record.instructions; }
}

function setup(limits: { idleTimeoutMs: number; maxSessionMs: number; reconnectDelaysMs?: number[] }, over: Partial<VoiceSessionOrchestratorDeps> = {}) {
  const env = freshAgentEnv();
  const provider = new FakeProvider();
  const global = env.agentStore.getOrCreateGlobalThread();
  env.agentStore.appendMessage({ threadId: global.id, role: "user", source: "user", content: { type: "text", text: "earlier" } });
  const closed: Array<{ reason: string; afterMs?: number }> = [];
  const states: string[] = [];
  let speak: (text: string, key?: string) => void = () => {};
  let subscribed = 0;
  let unsubscribed = 0;
  const orch = new VoiceSessionOrchestrator({
    agentStore: env.agentStore, threadId: global.id, provider,
    providerConfig: { apiKey: "k", model: "m", voice: "v", language: "auto", systemPrompt: "BASE", tools: [] },
    dispatcher: { registry: { tools: {} }, dispatch: async () => ({ result: null }) },
    buildToolScope: () => ({ kind: "manager", managerDir: "", projectWorkingDirs: [] }),
    sse: new AgentSseEmitter(), contextMessageCount: 5,
    reconnectDelaysMs: limits.reconnectDelaysMs ?? [5, 5],
    idleTimeoutMs: limits.idleTimeoutMs, maxSessionMs: limits.maxSessionMs,
    subscribeSpokenUpdates: (cb) => { subscribed += 1; speak = cb; return () => { unsubscribed += 1; }; },
    ...over
  });
  orch.on("onClose", (reason, afterMs) => closed.push(afterMs === undefined ? { reason } : { reason, afterMs }));
  orch.on("onReconnecting", () => states.push("reconnecting"));
  orch.on("onResumed", () => states.push("resumed"));
  return { env, provider, orch, closed, states, speak: (t: string, key?: string) => speak(t, key), subscriptions: () => ({ subscribed, unsubscribed }) };
}

const frame = { pcm: new ArrayBuffer(4800), sampleRate: 24000, channels: 1 as const };

// What a test waits for before it looks, however busy the machine: a fixed
// wait ran out under a loaded suite. A wait for something not to happen stays
// a fixed one: a slower machine only makes it surer.
const closedOnce = (s: ReturnType<typeof setup>) => waitUntil(() => s.closed.length > 0, { label: "voice closed" });
const resumed = (s: ReturnType<typeof setup>) => waitUntil(() => s.states.includes("resumed"), { label: () => `resumed, got ${JSON.stringify(s.states)}` });

test("idle fires while the mic streams silence: audio is not speech", async () => {
  const s = setup({ idleTimeoutMs: 40, maxSessionMs: 0 });
  try {
    await s.orch.start();
    for (let i = 0; i < 8; i++) { s.orch.sendAudio(frame); await Bun.sleep(10); }
    await closedOnce(s);
    expect(s.closed).toStrictEqual([{ reason: "idle-timeout", afterMs: 40 }]);
  } finally { await s.orch.close(); s.env.cleanup(); }
});

test("the user speaking restarts idle; the agent speaking does not", async () => {
  // Idle well beyond each wait, so a busy machine cannot run it out early.
  const s = setup({ idleTimeoutMs: 400, maxSessionMs: 0 });
  try {
    await s.orch.start();
    await Bun.sleep(60);
    s.provider.last.events.onSpeechStarted();
    s.provider.last.events.onSpeechStopped();
    await Bun.sleep(60);
    expect(s.closed).toStrictEqual([]);
    s.provider.last.events.onTranscript({ speaker: "assistant", text: "Two things wait on you.", isFinal: true });
    s.provider.last.events.onAudio(frame);
    await closedOnce(s);
    expect(s.closed.map((c) => c.reason)).toStrictEqual(["idle-timeout"]);
  } finally { await s.orch.close(); s.env.cleanup(); }
});

test("0 means no limit, for both", async () => {
  const s = setup({ idleTimeoutMs: 0, maxSessionMs: 0 });
  try {
    await s.orch.start();
    await Bun.sleep(60);
    expect(s.closed).toStrictEqual([]);
  } finally { await s.orch.close(); s.env.cleanup(); }
});

test("a provider that closes is reopened with the same tools, instructions and preload; the length limit keeps counting", async () => {
  // The limit well beyond the drop, so a busy machine cannot reach it first.
  const s = setup({ idleTimeoutMs: 0, maxSessionMs: 400 });
  try {
    await s.orch.start();
    await Bun.sleep(40);
    s.provider.last.events.onClose();
    await resumed(s);
    expect(s.states).toStrictEqual(["reconnecting", "resumed"]);
    expect(s.provider.sessions).toHaveLength(2);
    expect(s.provider.last.config.systemPrompt).toBe(s.provider.sessions[0]!.config.systemPrompt);
    expect(s.provider.last.preloaded).toStrictEqual([{ role: "user", text: "earlier" }]);
    await closedOnce(s);
    expect(s.closed.map((c) => c.reason)).toStrictEqual(["max-session-reached"]);
  } finally { await s.orch.close(); s.env.cleanup(); }
});

test("a provider that will not come back ends voice with a reason after the last retry", async () => {
  const s = setup({ idleTimeoutMs: 0, maxSessionMs: 0, reconnectDelaysMs: [5, 5, 5] });
  try {
    await s.orch.start();
    s.provider.failNext = 10;
    s.provider.last.events.onClose();
    await closedOnce(s);
    expect(s.states).toStrictEqual(["reconnecting"]);
    expect(s.closed).toStrictEqual([{ reason: "provider-unavailable" }]);
    expect(s.subscriptions()).toEqual({ subscribed: 1, unsubscribed: 1 });
  } finally { await s.orch.close(); s.env.cleanup(); }
});

test("our own close does not reconnect", async () => {
  const s = setup({ idleTimeoutMs: 0, maxSessionMs: 0 });
  try {
    await s.orch.start();
    await s.orch.close("client-closed");
    await Bun.sleep(20);
    expect(s.provider.sessions).toHaveLength(1);
    expect(s.states).toStrictEqual([]);
  } finally { s.env.cleanup(); }
});

test("a close that lands while the session starts leaves nothing behind", async () => {
  const s = setup({ idleTimeoutMs: 0, maxSessionMs: 0 });
  s.provider.duringStart = () => s.orch.close("client-closed");
  try {
    await s.orch.start();
    await Bun.sleep(20);
    expect(s.subscriptions()).toEqual({ subscribed: 0, unsubscribed: 0 });
    expect(s.states).toStrictEqual([]);
  } finally { s.env.cleanup(); }
});

test("a provider that drops while the session starts is reopened", async () => {
  const s = setup({ idleTimeoutMs: 0, maxSessionMs: 0 });
  s.provider.duringStart = () => s.provider.last.events.onClose();
  try {
    await s.orch.start();
    await resumed(s);
    expect(s.states).toStrictEqual(["reconnecting", "resumed"]);
    expect(s.provider.sessions).toHaveLength(2);
    expect(s.closed).toStrictEqual([]);
  } finally { await s.orch.close(); s.env.cleanup(); }
});

test("an old session's close, after a reconnect, is not a new drop", async () => {
  const s = setup({ idleTimeoutMs: 0, maxSessionMs: 0 });
  try {
    await s.orch.start();
    const first = s.provider.last;
    first.events.onClose();
    await resumed(s);
    first.events.onClose();
    await Bun.sleep(20);
    expect(s.states).toStrictEqual(["reconnecting", "resumed"]);
    expect(s.provider.sessions).toHaveLength(2);
  } finally { await s.orch.close(); s.env.cleanup(); }
});

test("an update that arrives while reconnecting is said after it resumes; one unheard when the provider dropped is said again", async () => {
  const s = setup({ idleTimeoutMs: 0, maxSessionMs: 0, reconnectDelaysMs: [20] });
  try {
    await s.orch.start();
    s.speak("release replied: ok");
    expect(s.provider.last.context).toHaveLength(1);
    s.provider.last.events.onClose(); // before the update's reply started
    s.speak("fisher: Ready for review");
    await waitUntil(() => s.states.length >= 2 && s.provider.last.context.length >= 1, { label: () => JSON.stringify(s.states) });
    expect(s.states).toStrictEqual(["reconnecting", "resumed"]);
    expect(s.provider.last.context).toHaveLength(1);
    expect(s.provider.last.context[0]).toContain("release replied: ok");
    expect(s.provider.last.context[0]).toContain("fisher: Ready for review");
  } finally { await s.orch.close(); s.env.cleanup(); }
});

test("an update heard in part when the provider dropped is not said again after it resumes, and counts as heard", async () => {
  const s = setup({ idleTimeoutMs: 0, maxSessionMs: 0, reconnectDelaysMs: [20] });
  const heard: string[][] = [];
  s.orch.on("onUpdatesHeard", (keys) => heard.push(keys));
  try {
    await s.orch.start();
    s.speak("release replied: ok", "h1:replied");
    s.provider.last.events.onResponseCreated({ responseId: "r1", metadata: responseMetadata("update") });
    s.provider.last.events.onAudio(frame);
    s.provider.last.events.onClose(); // mid-sentence
    await waitUntil(() => s.states.length >= 2 && heard.length >= 1, { label: () => JSON.stringify(s.states) });
    expect(s.states).toStrictEqual(["reconnecting", "resumed"]);
    expect(s.provider.last.context).toStrictEqual([]);
    expect(heard).toStrictEqual([["h1:replied"]]);
  } finally { await s.orch.close(); s.env.cleanup(); }
});

test("a tool result from before a reconnect is not handed to the new session", async () => {
  let release!: () => void;
  const s = setup({ idleTimeoutMs: 0, maxSessionMs: 0 }, {
    providerConfig: { apiKey: "k", model: "m", voice: "v", language: "auto", systemPrompt: "BASE", tools: [{ name: "look", description: "l", parameters: z.object({}), handler: async () => ({}) }] },
    dispatcher: { registry: { tools: {} }, dispatch: () => new Promise((resolve) => { release = () => resolve({ result: "ok" }); }) }
  });
  try {
    await s.orch.start();
    s.provider.last.events.onToolCall({ callId: "c1", name: "look", args: {}, responseId: "r0" });
    s.provider.last.events.onClose();
    await resumed(s);
    expect(s.states).toStrictEqual(["reconnecting", "resumed"]);
    release();
    await Bun.sleep(5);
    expect(s.provider.sessions.map((session) => session.toolOutputs)).toEqual([[], []]);
  } finally { await s.orch.close(); s.env.cleanup(); }
});

test("the user mid-sentence is not idle, however long the sentence", async () => {
  const s = setup({ idleTimeoutMs: 40, maxSessionMs: 0 });
  try {
    await s.orch.start();
    s.provider.last.events.onSpeechStarted();
    await Bun.sleep(90);
    expect(s.closed).toStrictEqual([]);
    s.provider.last.events.onSpeechStopped();
    await closedOnce(s);
    expect(s.closed.map((c) => c.reason)).toStrictEqual(["idle-timeout"]);
  } finally { await s.orch.close(); s.env.cleanup(); }
});

test("a stop while a reconnect builds its context opens nothing", async () => {
  let finish!: () => void;
  let holding = false;
  const s = setup({ idleTimeoutMs: 0, maxSessionMs: 0, reconnectDelaysMs: [5] }, {
    buildRuntimeContext: () => holding ? new Promise<string>((resolve) => { finish = () => resolve("ctx"); }) : Promise.resolve("ctx")
  });
  try {
    await s.orch.start();
    holding = true;
    s.provider.last.events.onClose();
    await waitUntil(() => finish, { label: "the reconnect building its context" });
    await s.orch.close("client-closed");
    finish();
    await Bun.sleep(10);
    expect(s.provider.startCalls).toBe(1);
  } finally { s.env.cleanup(); }
});

test("a stop while a reconnect waits on the provider cancels that opening", async () => {
  const s = setup({ idleTimeoutMs: 0, maxSessionMs: 0, reconnectDelaysMs: [5] });
  try {
    await s.orch.start();
    s.provider.holdNext = true;
    s.provider.last.events.onClose();
    await waitUntil(() => s.provider.startCalls === 2, { label: "the reconnect waiting on the provider" });
    await s.orch.close("client-closed");
    await waitUntil(() => s.provider.aborted >= 1, { label: "the opening cancelled" });
    expect(s.provider.aborted).toBe(1);
    expect(s.provider.startCalls).toBe(2);
  } finally { s.env.cleanup(); }
});

test("a tool from before a reconnect that finishes after it lets a waiting update go out", async () => {
  let release!: () => void;
  const s = setup({ idleTimeoutMs: 0, maxSessionMs: 0 }, {
    providerConfig: { apiKey: "k", model: "m", voice: "v", language: "auto", systemPrompt: "BASE", tools: [{ name: "look", description: "l", parameters: z.object({}), handler: async () => ({}) }] },
    dispatcher: { registry: { tools: {} }, dispatch: () => new Promise((resolve) => { release = () => resolve({ result: "ok" }); }) }
  });
  try {
    await s.orch.start();
    s.provider.last.events.onToolCall({ callId: "c1", name: "look", args: {}, responseId: "r0" });
    s.provider.last.events.onClose();
    s.speak("release replied: ok");
    await resumed(s);
    expect(s.states).toStrictEqual(["reconnecting", "resumed"]);
    expect(s.provider.last.context).toStrictEqual([]); // the old tool still runs
    release();
    await waitUntil(() => s.provider.last.context.length >= 1, { label: "the update said" });
    expect(s.provider.last.context).toHaveLength(1);
  } finally { await s.orch.close(); s.env.cleanup(); }
});

test("a change raised while a reconnect builds its context still reaches the reopened session", async () => {
  let finish!: (text: string) => void;
  let holding = false;
  let current = "ctx-1";
  let changed: () => void = () => {};
  const s = setup({ idleTimeoutMs: 0, maxSessionMs: 0, reconnectDelaysMs: [5] }, {
    contextRefreshMs: 10,
    buildRuntimeContext: () => holding ? new Promise<string>((resolve) => { finish = resolve; }) : Promise.resolve(current),
    subscribeContextChanges: (cb) => { changed = cb; return () => {}; }
  });
  try {
    await s.orch.start();
    holding = true;
    s.provider.last.events.onClose();
    await waitUntil(() => finish, { label: "the reconnect building ctx-2" });
    current = "ctx-3";
    changed(); // a worker was archived meanwhile
    holding = false;
    finish("ctx-2");
    await resumed(s);
    expect(s.states).toStrictEqual(["reconnecting", "resumed"]);
    expect(s.provider.last.config.systemPrompt).toBe("BASE\n\nctx-2");
    // The reopened session hears the change.
    await waitUntil(() => s.provider.instructionsFor(s.provider.last).length >= 1, { label: "the change heard" });
    expect(s.provider.instructionsFor(s.provider.last)).toEqual(["BASE\n\nctx-3"]);
  } finally { await s.orch.close(); s.env.cleanup(); }
});

test("a refresh begun before a drop is not applied to the session opened after it", async () => {
  let finish!: (text: string) => void;
  let holding = false;
  let current = "ctx-1";
  let changed: () => void = () => {};
  const s = setup({ idleTimeoutMs: 0, maxSessionMs: 0, reconnectDelaysMs: [5] }, {
    contextRefreshMs: 5,
    buildRuntimeContext: () => holding ? new Promise<string>((resolve) => { finish = resolve; }) : Promise.resolve(current),
    subscribeContextChanges: (cb) => { changed = cb; return () => {}; }
  });
  try {
    await s.orch.start();
    holding = true;
    changed();
    await waitUntil(() => finish, { label: "the refresh building ctx-2" });
    holding = false;
    current = "ctx-3";
    s.provider.last.events.onClose();
    await resumed(s); // reopened with ctx-3
    expect(s.provider.last.config.systemPrompt).toBe("BASE\n\nctx-3");
    finish("ctx-2");
    await Bun.sleep(10);
    expect(s.provider.instructionsFor(s.provider.last)).toEqual([]);
  } finally { await s.orch.close(); s.env.cleanup(); }
});

test("a provider that drops while its opening is still pending has that opening cancelled, then is reopened", async () => {
  const s = setup({ idleTimeoutMs: 0, maxSessionMs: 0 });
  s.provider.holdNext = true;
  try {
    const starting = s.orch.start();
    await waitUntil(() => s.provider.release, { label: "the opening pending" });
    s.provider.last.events.onClose(); // the pending opening's socket dropped
    await starting;
    await resumed(s);
    expect(s.provider.aborted).toBe(1);
    expect(s.states).toStrictEqual(["reconnecting", "resumed"]);
    expect(s.closed).toStrictEqual([]);
  } finally { await s.orch.close(); s.env.cleanup(); }
});

test("a reconnect attempt that drops before it is taken is not resumed: the next attempt is", async () => {
  const s = setup({ idleTimeoutMs: 0, maxSessionMs: 0, reconnectDelaysMs: [5, 5, 5] });
  try {
    await s.orch.start();
    s.provider.last.events.onClose();
    // The first retry answers, then its socket closes before it is taken.
    s.provider.duringStart = () => s.provider.last.events.onClose();
    await waitUntil(() => s.states.length >= 2 && s.provider.sessions.length >= 3, { label: () => JSON.stringify(s.states) });
    expect(s.states).toStrictEqual(["reconnecting", "resumed"]);
    expect(s.provider.sessions).toHaveLength(3);
    expect(s.closed).toStrictEqual([]);
  } finally { await s.orch.close(); s.env.cleanup(); }
});

test("a reconnect attempt that drops just as it is taken is not resumed: the next attempt is", async () => {
  const s = setup({ idleTimeoutMs: 0, maxSessionMs: 0, reconnectDelaysMs: [5, 5, 5] });
  try {
    await s.orch.start();
    s.provider.last.events.onClose();
    s.provider.duringPreload = () => s.provider.last.events.onClose();
    await waitUntil(() => s.states.length >= 2 && s.provider.sessions.length >= 3, { label: () => JSON.stringify(s.states) });
    expect(s.states).toStrictEqual(["reconnecting", "resumed"]);
    expect(s.provider.sessions).toHaveLength(3);
  } finally { await s.orch.close(); s.env.cleanup(); }
});

test("a stop while the dropped session is still closing starts no reconnect", async () => {
  const s = setup({ idleTimeoutMs: 0, maxSessionMs: 0, reconnectDelaysMs: [5] });
  try {
    await s.orch.start();
    s.provider.onSessionClose = () => s.orch.close("client-closed");
    s.provider.last.events.onClose();
    await Bun.sleep(30);
    expect(s.states).toStrictEqual([]);
    expect(s.provider.startCalls).toBe(1);
  } finally { s.env.cleanup(); }
});

