import { expect, test } from "bun:test";
import { z } from "zod";
import { freshAgentEnv } from "./helpers/fixtures.js";
import {
  VoiceSessionOrchestrator,
  responseMetadata,
  type VoiceSessionOrchestratorDeps
} from "../src/server/modules/voice/voice-session-orchestrator.js";
import type { VoiceProvider, VoiceSession, VoiceSessionEvents, VoiceProviderConfig } from "../src/server/modules/voice/voice-provider.js";
import { AgentSseEmitter } from "../src/server/modules/sse/sse-events.js";
import { startSpokenUpdateSource } from "../src/server/modules/voice/spoken-updates.js";
import { SSE_EVENTS } from "../src/shared/api-contracts.js";
import type { WaitingEntryDto } from "../src/shared/api/thread-status.js";

class FakeProvider implements VoiceProvider {
  events: VoiceSessionEvents | null = null;
  config: VoiceProviderConfig | null = null;
  /** User items: the update messages. */
  context: string[] = [];
  toolOutputs: string[] = [];
  /** response.create calls, by tag ("none" when untagged). */
  requests: Array<{ tag: string; toolChoice: string | undefined }> = [];
  instructions: string[] = [];
  /** Dialogue items added to the conversation: the preload, then live. */
  preloaded: Array<{ role: "user" | "assistant"; text: string }> = [];
  cancels = 0;
  async startSession(config: VoiceProviderConfig, events: VoiceSessionEvents): Promise<VoiceSession> {
    this.config = config;
    this.events = events;
    return {
      sendAudio: () => {}, truncateItem: () => {}, close: async () => {},
      preloadHistory: (items) => { this.preloaded.push(...items); },
      cancelResponse: () => { this.cancels += 1; },
      sendToolResult: (callId) => { this.toolOutputs.push(callId); },
      sendContextMessage: (text) => { this.context.push(text); },
      requestResponse: (options) => { this.requests.push({ tag: options?.metadata?.mandate ?? "none", toolChoice: options?.toolChoice }); },
      updateInstructions: (text) => { this.instructions.push(text); }
    };
  }
}

const tool = (name: string) => ({ name, description: name, parameters: z.object({}), handler: async () => ({}) });

/** A dispatcher whose calls finish when the test says so. */
function heldDispatcher() {
  const held = new Map<string, () => void>();
  return {
    held,
    dispatcher: {
      registry: { tools: {} },
      dispatch: (call: { toolCallId: string }) => new Promise<{ result: unknown }>((resolve) => { held.set(call.toolCallId, () => resolve({ result: "ok" })); })
    }
  };
}

function setup(over: Partial<VoiceSessionOrchestratorDeps> & { provider?: FakeProvider } = {}) {
  const env = freshAgentEnv();
  const provider = over.provider ?? new FakeProvider();
  const global = env.agentStore.getOrCreateGlobalThread();
  let speak: (text: string, key?: string) => void = () => {};
  let changed: () => void = () => {};
  let contextText = "ctx-1";
  let subscribed = 0;
  let unsubscribed = 0;
  const orch = new VoiceSessionOrchestrator({
    agentStore: env.agentStore, threadId: global.id, provider,
    providerConfig: { apiKey: "k", model: "m", voice: "v", language: "auto", systemPrompt: "BASE", tools: [tool("look"), tool("slow")] },
    dispatcher: { registry: { tools: {} }, dispatch: async () => ({ result: null }) },
    buildToolScope: () => ({ kind: "manager", managerDir: "", projectWorkingDirs: [] }),
    sse: new AgentSseEmitter(), idleTimeoutMs: 60_000, maxSessionMs: 60_000, contextMessageCount: 0,
    buildRuntimeContext: async () => contextText,
    subscribeContextChanges: (cb) => { subscribed += 1; changed = cb; return () => { unsubscribed += 1; }; },
    subscribeSpokenUpdates: (cb) => { subscribed += 1; speak = cb; return () => { unsubscribed += 1; }; },
    contextRefreshMs: 20,
    replyGraceMs: 60_000,
    ...over
  });
  const ev = () => provider.events!;
  return {
    env, provider, global, orch,
    speak: (t: string, key?: string) => speak(t, key),
    changed: () => changed(),
    setContext: (t: string) => { contextText = t; },
    subscriptions: () => ({ subscribed, unsubscribed }),
    /** A response starts: ours carry their tag; server VAD's carry none. */
    created: (responseId: string, kind?: "update" | "continuation") =>
      ev().onResponseCreated({ responseId, metadata: kind ? responseMetadata(kind) : null }),
    done: (responseId: string, status = "completed") => ev().onResponseDone({ responseId, status }),
    call: (responseId: string, callId: string, name = "look") => ev().onToolCall({ callId, name, args: {}, responseId }),
    say: (responseId: string, text: string) => ev().onTranscript({ speaker: "assistant", text, isFinal: true }, { responseId }),
    audio: () => ev().onAudio({ pcm: new ArrayBuffer(4800), sampleRate: 24000, channels: 1 }),
    tags: () => provider.requests.map((r) => r.tag),
    rows: () => env.agentStore.getMessages(global.id).filter((m) => m.role === "assistant" && (m.content as { text?: string }).text)
      .map((m) => [(m.content as { text: string }).text, (m.content as { spokenUpdate?: boolean }).spokenUpdate ?? false])
  };
}

test("the session opens with the base instructions and the current context", async () => {
  const s = setup();
  try {
    await s.orch.start();
    expect(s.provider.config!.systemPrompt).toBe("BASE\n\nctx-1");
  } finally { await s.orch.close(); s.env.cleanup(); }
});

test("an update waits while the user speaks and while a reply is playing, then goes out once, asked for without tools", async () => {
  const s = setup();
  try {
    await s.orch.start();
    s.provider.events!.onSpeechStarted();
    s.speak("release replied: OK, the install script stays.");
    expect(s.provider.context).toStrictEqual([]);
    // Server VAD answers the user's speech by itself: the update waits for that reply.
    s.provider.events!.onSpeechStopped();
    expect(s.provider.context).toStrictEqual([]);
    s.created("r0");
    s.done("r0");
    expect(s.provider.context).toHaveLength(1);
    expect(s.provider.context[0]).toContain("release replied: OK, the install script stays.");
    expect(s.provider.requests).toStrictEqual([{ tag: "update", toolChoice: "none" }]);
    s.created("r1", "update");
    s.speak("fisher: Ready for review");
    s.speak("PR reviews: stopped");
    expect(s.provider.context).toHaveLength(1);
    s.done("r1");
    expect(s.provider.context).toHaveLength(2);
    expect(s.provider.context[1]).toContain("fisher: Ready for review");
    expect(s.provider.context[1]).toContain("PR reviews: stopped");
  } finally { await s.orch.close(); s.env.cleanup(); }
});

test("an update that arrives after the user stopped, before the reply starts, waits for that reply", async () => {
  const s = setup();
  try {
    await s.orch.start();
    s.provider.events!.onSpeechStarted();
    s.provider.events!.onSpeechStopped();
    s.speak("release replied: ok");
    expect(s.provider.context).toStrictEqual([]);
    s.created("r0");
    s.done("r0");
    expect(s.provider.context).toHaveLength(1);
  } finally { await s.orch.close(); s.env.cleanup(); }
});

test("when no reply follows the user's speech, a waiting update goes out after the grace", async () => {
  const s = setup({ replyGraceMs: 30 });
  try {
    await s.orch.start();
    s.provider.events!.onSpeechStarted();
    s.speak("fisher: Ready for review");
    s.provider.events!.onSpeechStopped();
    expect(s.provider.context).toStrictEqual([]);
    await Bun.sleep(60);
    expect(s.provider.context).toHaveLength(1);
    expect(s.provider.context[0]).toContain("fisher: Ready for review");
  } finally { await s.orch.close(); s.env.cleanup(); }
});

test("a second update waits for the first one's reply, even before that reply has started", async () => {
  const s = setup();
  try {
    await s.orch.start();
    s.speak("release replied: ok");
    s.speak("fisher: Ready for review");
    expect(s.provider.context).toStrictEqual([expect.stringContaining("release replied: ok")]);
    s.created("r1", "update");
    s.done("r1");
    expect(s.provider.context).toHaveLength(2);
    expect(s.provider.context[1]).toContain("fisher: Ready for review");
  } finally { await s.orch.close(); s.env.cleanup(); }
});

test("speech that starts before an update's reply exists cancels it, silenced, and the update is said at the next pause", async () => {
  const s = setup();
  const heard: number[] = [];
  s.orch.on("onAudio", () => heard.push(1));
  try {
    await s.orch.start();
    s.speak("release replied: ok");
    s.provider.events!.onSpeechStarted();
    expect(s.provider.cancels).toBe(1);
    s.created("r1", "update");
    s.audio();
    expect(heard).toStrictEqual([]);
    s.done("r1", "cancelled");
    s.provider.events!.onSpeechStopped();
    s.created("r2");
    s.done("r2");
    expect(s.provider.context).toHaveLength(2);
    expect(s.provider.context[1]).toContain("release replied: ok");
  } finally { await s.orch.close(); s.env.cleanup(); }
});

test("a short interjection before an update's reply starts still cancels it unheard", async () => {
  const s = setup();
  const heard: number[] = [];
  s.orch.on("onAudio", () => heard.push(1));
  try {
    await s.orch.start();
    s.speak("release replied: ok");
    s.provider.events!.onSpeechStarted();
    s.provider.events!.onSpeechStopped(); // "Mm" — over before the update's reply shows up
    s.created("r1", "update");
    s.audio();
    expect(heard).toStrictEqual([]);
    s.done("r1", "cancelled");
    s.created("r2");
    s.done("r2");
    expect(s.provider.context).toHaveLength(2);
    expect(s.provider.context[1]).toContain("release replied: ok");
  } finally { await s.orch.close(); s.env.cleanup(); }
});

test("an update cut off before it said anything is said again; one cut off after it spoke is not", async () => {
  const s = setup();
  try {
    await s.orch.start();
    s.speak("release replied: ok");
    s.created("r1", "update");
    s.provider.events!.onSpeechStarted();
    s.done("r1", "cancelled");
    s.provider.events!.onSpeechStopped();
    s.created("r2");
    s.done("r2");
    expect(s.provider.context).toHaveLength(2);
    s.created("r3", "update");
    s.audio();
    s.provider.events!.onSpeechStarted();
    s.done("r3", "cancelled");
    s.provider.events!.onSpeechStopped();
    s.created("r4");
    s.done("r4");
    expect(s.provider.context).toHaveLength(2);
  } finally { await s.orch.close(); s.env.cleanup(); }
});

test("a tool result that comes back while its reply still speaks is continued once that reply ends", async () => {
  const s = setup();
  try {
    await s.orch.start();
    s.created("r0");
    s.call("r0", "c1");
    await Bun.sleep(5);
    expect(s.provider.toolOutputs).toStrictEqual(["c1"]);
    expect(s.tags()).toEqual([]);
    s.done("r0");
    expect(s.tags()).toEqual(["continuation"]);
  } finally { await s.orch.close(); s.env.cleanup(); }
});

test("a reply's tools get one continuation, after the last result", async () => {
  const { held, dispatcher } = heldDispatcher();
  const s = setup({ dispatcher });
  try {
    await s.orch.start();
    s.created("r0");
    s.call("r0", "c1");
    s.call("r0", "c2", "slow");
    s.done("r0");
    held.get("c1")!();
    await Bun.sleep(5);
    expect(s.tags()).toEqual([]);
    held.get("c2")!();
    await Bun.sleep(5);
    expect(s.tags()).toEqual(["continuation"]);
  } finally { await s.orch.close(); s.env.cleanup(); }
});

test("a reply whose tool is still running finishes, continuation included, before an update goes out", async () => {
  const { held, dispatcher } = heldDispatcher();
  const s = setup({ dispatcher });
  try {
    await s.orch.start();
    s.created("r0");
    s.call("r0", "c1", "slow");
    s.speak("release replied: ok");
    s.done("r0");
    expect(s.provider.context).toStrictEqual([]);
    held.get("c1")!();
    await Bun.sleep(5);
    expect(s.tags()).toEqual(["continuation"]);
    expect(s.provider.context).toStrictEqual([]);
    s.created("r1", "continuation");
    s.done("r1");
    expect(s.provider.context).toHaveLength(1);
    expect(s.tags()).toEqual(["continuation", "update"]);
  } finally { await s.orch.close(); s.env.cleanup(); }
});

test("server VAD's reply to new speech stands in for a continuation still wanted", async () => {
  const { held, dispatcher } = heldDispatcher();
  const s = setup({ dispatcher });
  try {
    await s.orch.start();
    s.created("r0");
    s.call("r0", "c1", "slow");
    s.done("r0");
    s.provider.events!.onSpeechStarted();
    held.get("c1")!();
    await Bun.sleep(5);
    expect(s.tags()).toEqual([]);
    s.provider.events!.onSpeechStopped();
    s.created("r1");
    s.done("r1");
    expect(s.tags()).toEqual([]);
  } finally { await s.orch.close(); s.env.cleanup(); }
});

test("a continuation asked for just before the user speaks is cancelled unheard when it starts", async () => {
  const s = setup();
  const heard: number[] = [];
  s.orch.on("onAudio", () => heard.push(1));
  try {
    await s.orch.start();
    s.created("r0");
    s.call("r0", "c1");
    await Bun.sleep(5);
    s.done("r0");
    expect(s.tags()).toEqual(["continuation"]);
    s.provider.events!.onSpeechStarted();
    const cancels = s.provider.cancels;
    s.created("r1", "continuation");
    expect(s.provider.cancels).toBe(cancels + 1);
    s.audio();
    expect(heard).toStrictEqual([]);
  } finally { await s.orch.close(); s.env.cleanup(); }
});

test("a continuation refused because server VAD's reply was under way is not asked again", async () => {
  const s = setup();
  try {
    await s.orch.start();
    s.created("r0");
    s.call("r0", "c1");
    await Bun.sleep(5);
    s.done("r0");
    expect(s.tags()).toEqual(["continuation"]);
    s.created("r1");
    s.provider.events!.onResponseRejected("busy");
    s.done("r1");
    expect(s.tags()).toEqual(["continuation"]);
  } finally { await s.orch.close(); s.env.cleanup(); }
});

test("an update refused because a reply was already under way is said after that reply", async () => {
  const s = setup();
  try {
    await s.orch.start();
    s.speak("release replied: ok");
    expect(s.provider.context).toHaveLength(1);
    s.provider.events!.onResponseRejected("busy");
    expect(s.provider.context).toHaveLength(1);
    s.created("r0");
    s.done("r0");
    expect(s.provider.context).toHaveLength(2);
    expect(s.provider.context[1]).toContain("release replied: ok");
  } finally { await s.orch.close(); s.env.cleanup(); }
});

test("a provider that does not echo the tag neither stalls updates nor repeats one", async () => {
  const s = setup();
  try {
    await s.orch.start();
    s.speak("release replied: ok");
    s.created("r1"); // ours, but untagged
    s.done("r1");
    s.speak("fisher: Ready for review");
    expect(s.provider.context).toHaveLength(2);
    expect(s.provider.context[1]).toContain("fisher: Ready for review");
    expect(s.provider.context[1]).not.toContain("release replied: ok");
  } finally { await s.orch.close(); s.env.cleanup(); }
});

test("the reply to an update is recorded as a spoken update; the user's own replies and continuations never are", async () => {
  const s = setup({ replyGraceMs: 30 });
  try {
    await s.orch.start();
    s.provider.events!.onSpeechStarted();
    s.speak("release replied: ok");
    s.provider.events!.onSpeechStopped();
    await Bun.sleep(60); // the grace passes: the update goes out before VAD's reply shows up
    expect(s.provider.context).toHaveLength(1);
    s.created("r0");
    s.say("r0", "Sure, opening it.");
    s.call("r0", "c1");
    await Bun.sleep(5);
    s.done("r0");
    s.created("r1", "update");
    s.say("r1", "release answered, the install script stays.");
    s.done("r1");
    s.created("r2", "continuation");
    s.say("r2", "It's open.");
    s.done("r2");
    expect(s.rows()).toEqual([
      ["Sure, opening it.", false],
      ["release answered, the install script stays.", true],
      ["It's open.", false]
    ]);
  } finally { await s.orch.close(); s.env.cleanup(); }
});

test("a changed context reaches the model, throttled, never mid-reply", async () => {
  const s = setup({ contextRefreshMs: 30 });
  try {
    await s.orch.start();
    s.setContext("ctx-2");
    s.changed();
    s.changed();
    await Bun.sleep(60);
    expect(s.provider.instructions).toStrictEqual(["BASE\n\nctx-2"]);
    s.created("r1");
    s.setContext("ctx-3");
    s.changed();
    await Bun.sleep(60);
    expect(s.provider.instructions).toHaveLength(1);
    s.done("r1");
    await Bun.sleep(60);
    expect(s.provider.instructions).toStrictEqual(["BASE\n\nctx-2", "BASE\n\nctx-3"]);
    // An unchanged context is not sent again.
    s.changed();
    await Bun.sleep(60);
    expect(s.provider.instructions).toHaveLength(2);
  } finally { await s.orch.close(); s.env.cleanup(); }
});

function slowContext() {
  let finish!: (text: string) => void;
  let building = false;
  let current = "ctx-1";
  return {
    build: () => building ? new Promise<string>((resolve) => { finish = resolve; }) : Promise.resolve(current),
    hold: () => { building = true; },
    finish: (text: string) => finish(text),
    settle: (text: string) => { building = false; current = text; }
  };
}

test("a reply that starts while the context is being built holds the new context until it ends", async () => {
  const ctx = slowContext();
  const s = setup({ contextRefreshMs: 10, buildRuntimeContext: ctx.build });
  try {
    await s.orch.start();
    ctx.hold();
    s.changed();
    await Bun.sleep(30);
    s.created("r1");
    ctx.finish("ctx-2");
    await Bun.sleep(5);
    expect(s.provider.instructions).toStrictEqual([]);
    ctx.settle("ctx-2");
    s.done("r1");
    await Bun.sleep(40);
    expect(s.provider.instructions).toStrictEqual(["BASE\n\nctx-2"]);
  } finally { await s.orch.close(); s.env.cleanup(); }
});

test("a context built while an update is asked for waits for that update's reply", async () => {
  const ctx = slowContext();
  const s = setup({ contextRefreshMs: 10, buildRuntimeContext: ctx.build });
  try {
    await s.orch.start();
    ctx.hold();
    s.changed();
    await Bun.sleep(30);
    s.speak("release replied: ok");
    ctx.finish("ctx-2");
    await Bun.sleep(5);
    expect(s.provider.instructions).toStrictEqual([]);
    ctx.settle("ctx-2");
    s.created("r1", "update");
    s.done("r1");
    await Bun.sleep(40);
    expect(s.provider.instructions).toStrictEqual(["BASE\n\nctx-2"]);
  } finally { await s.orch.close(); s.env.cleanup(); }
});

test("a context built while a reply's continuation is due waits for that continuation", async () => {
  const ctx = slowContext();
  const s = setup({ contextRefreshMs: 10, buildRuntimeContext: ctx.build });
  try {
    await s.orch.start();
    ctx.hold();
    s.changed();
    await Bun.sleep(30); // the build is under way
    s.created("r0");
    s.call("r0", "c1");
    await Bun.sleep(5);
    s.done("r0"); // asks for the continuation
    expect(s.tags()).toEqual(["continuation"]);
    ctx.finish("ctx-2");
    await Bun.sleep(5);
    expect(s.provider.instructions).toStrictEqual([]);
    ctx.settle("ctx-2");
    s.created("r1", "continuation");
    s.done("r1");
    await Bun.sleep(40);
    expect(s.provider.instructions).toStrictEqual(["BASE\n\nctx-2"]);
  } finally { await s.orch.close(); s.env.cleanup(); }
});

test("a context that fails to build leaves the session on what it had", async () => {
  const s = setup({ buildRuntimeContext: async () => { throw new Error("memory search failed"); } });
  try {
    await s.orch.start();
    expect(s.provider.config!.systemPrompt).toBe("BASE");
    s.changed();
    await Bun.sleep(50);
    expect(s.provider.instructions).toStrictEqual([]);
  } finally { await s.orch.close(); s.env.cleanup(); }
});

test("closing the session stops both subscriptions", async () => {
  const s = setup();
  await s.orch.start();
  await s.orch.close();
  expect(s.subscriptions()).toEqual({ subscribed: 2, unsubscribed: 2 });
  s.env.cleanup();
});

test("an update that cannot go out does not hold an idle session open", async () => {
  const s = setup({ idleTimeoutMs: 40 });
  const reasons: string[] = [];
  s.orch.on("onClose", (reason) => reasons.push(reason));
  try {
    await s.orch.start();
    s.created("r0"); // a reply that never finishes
    s.speak("release replied: ok");
    await Bun.sleep(90);
    expect(reasons).toStrictEqual(["idle-timeout"]);
  } finally { await s.orch.close(); s.env.cleanup(); }
});

test("typed dialogue that lands while voice is live reaches its conversation; voice's own lines, model-only rows and other threads do not", async () => {
  const sse = new AgentSseEmitter();
  const s = setup({ sse, contextMessageCount: 5 });
  try {
    await s.orch.start();
    const before = s.provider.preloaded.length;
    const append = (threadId: string, source: "self" | "voice" | "runtime-context" | "user", role: "user" | "assistant", text: string) => {
      const content = role === "assistant" ? { type: "assistant" as const, text, toolCalls: [] } : { type: "text" as const, text };
      const message = s.env.agentStore.appendMessage({ threadId, role, source, content });
      sse.emit(SSE_EVENTS.agentMessageAppended, { threadId, message });
    };
    append(s.global.id, "user", "user", "what should I do about the race?");
    append(s.global.id, "self", "assistant", "I suggest rerunning the race test.");
    append(s.global.id, "voice", "assistant", "said aloud already");
    append(s.global.id, "runtime-context", "user", "[context]");
    append(s.env.agentStore.createManagerThread("PR reviews").id, "user", "user", "elsewhere");
    expect(s.provider.preloaded.slice(before)).toEqual([
      { role: "user", text: "what should I do about the race?" },
      { role: "assistant", text: "I suggest rerunning the race test." }
    ]);
  } finally { await s.orch.close(); s.env.cleanup(); }
});

test("an update waits until the reply before it has played out in the browser; the user speaking, which stops that playback, ends the wait", async () => {
  const s = setup();
  try {
    await s.orch.start();
    s.created("r0");
    s.audio(); s.audio(); // 200 ms of reply, generated faster than it plays
    s.done("r0");
    s.speak("release replied: ok", "h1:replied");
    expect(s.provider.context).toStrictEqual([]);
    await Bun.sleep(260);
    expect(s.provider.context).toHaveLength(1);
    s.created("r1", "update");
    s.audio();
    s.done("r1");
    s.speak("fisher replied: done", "h2:replied");
    expect(s.provider.context).toHaveLength(1);
    s.provider.events!.onSpeechStarted(); // the browser drops what it had queued
    s.provider.events!.onSpeechStopped();
    s.created("r2");
    s.done("r2");
    expect(s.provider.context).toHaveLength(2);
  } finally { await s.orch.close(); s.env.cleanup(); }
});

test("an outcome counts as heard when its update's reply ends or any of it played; cut off unheard, or never said, it does not", async () => {
  const s = setup();
  const heard: string[][] = [];
  s.orch.on("onUpdatesHeard", (keys) => heard.push(keys));
  try {
    await s.orch.start();
    s.speak("release replied: ok", "h1:replied");
    s.speak("PR reviews: stopped (it kept repeating)"); // not an outcome: nothing to count
    s.created("r1", "update");
    s.done("r1", "cancelled"); // cut off before any of it played: said again
    expect(heard).toStrictEqual([]);
    s.created("r2", "update");
    s.done("r2");
    expect(heard).toStrictEqual([["h1:replied"]]);
    s.speak("fisher replied: done", "h2:replied");
    s.created("r3", "update");
    s.audio(); // some of it played …
    await s.orch.close(); // … before the page went away
    expect(heard).toStrictEqual([["h1:replied"], ["h2:replied"]]);
  } finally { await s.orch.close(); s.env.cleanup(); }
});

test("an update whose reply fails before saying anything, or whose request the service refuses, is not heard", async () => {
  for (const failure of ["failed", "refused"] as const) {
    const s = setup();
    const heard: string[][] = [];
    s.orch.on("onUpdatesHeard", (keys) => heard.push(keys));
    try {
      await s.orch.start();
      s.speak("release replied: ok", "h1:replied");
      if (failure === "failed") {
        s.created("r1", "update");
        s.done("r1", "failed"); // a provider error, no audio
      } else {
        s.provider.events!.onResponseRejected("error"); // a rate limit, say: no response follows
      }
      await s.orch.close();
      expect([failure, heard]).toEqual([failure, []]);
    } finally { await s.orch.close(); s.env.cleanup(); }
  }
});

test("a continuation the service refused with an error is not asked again, and an update waiting behind it goes on", async () => {
  const s = setup();
  try {
    await s.orch.start();
    s.created("r0");
    s.call("r0", "c1");
    await Bun.sleep(5);
    s.speak("release replied: ok", "h1:replied"); // waits for the reply's continuation
    s.done("r0");
    expect(s.tags()).toEqual(["continuation"]);
    s.provider.events!.onResponseRejected("error"); // nothing follows
    expect(s.tags()).toEqual(["continuation", "update"]);
  } finally { await s.orch.close(); s.env.cleanup(); }
});

test("a context change while the provider opened reaches the session once it is open", async () => {
  class SlowProvider extends FakeProvider {
    release: () => void = () => {};
    override async startSession(config: VoiceProviderConfig, events: VoiceSessionEvents): Promise<VoiceSession> {
      await new Promise<void>((resolve) => { this.release = resolve; });
      return super.startSession(config, events);
    }
  }
  const provider = new SlowProvider();
  const s = setup({ provider });
  try {
    const started = s.orch.start();
    await Bun.sleep(5); // the opening context is built, the handshake pending
    s.setContext("ctx-2"); // a proposal typed in another tab, say
    provider.release();
    await started;
    await Bun.sleep(10);
    expect(provider.instructions).toStrictEqual(["BASE\n\nctx-2"]);
  } finally { await s.orch.close(); s.env.cleanup(); }
});

test("an outcome queued while the user talked, or asked for and not yet started, is not heard when the session ends", async () => {
  for (const asked of [false, true]) {
    const s = setup();
    const heard: string[][] = [];
    s.orch.on("onUpdatesHeard", (keys) => heard.push(keys));
    try {
      await s.orch.start();
      if (!asked) s.provider.events!.onSpeechStarted();
      s.speak("release replied: ok", "h1:replied");
      expect(s.tags()).toEqual(asked ? ["update"] : []);
      await s.orch.close();
      expect([asked, heard]).toEqual([asked, []]);
    } finally { await s.orch.close(); s.env.cleanup(); }
  }
});

test("updates are asked for from when voice was turned on, less what this activation already heard", async () => {
  const heardBefore = new Set(["h0:replied"]);
  let from: unknown = null;
  const s = setup({
    startedAtMs: Date.parse("2026-10-06T08:00:00.000Z"), maxSessionMs: 0, heardUpdates: heardBefore,
    subscribeSpokenUpdates: (_cb, f) => { from = f; return () => {}; }
  });
  try {
    await s.orch.start();
    expect(from).toEqual({ since: "2026-10-06T08:00:00.000Z", heard: heardBefore });
  } finally { await s.orch.close(); s.env.cleanup(); }
});

test("a session with no clocks of its own asks for updates from before its provider opened", async () => {
  class SlowProvider extends FakeProvider {
    openedAt = 0;
    override async startSession(config: VoiceProviderConfig, events: VoiceSessionEvents): Promise<VoiceSession> {
      await Bun.sleep(30);
      this.openedAt = Date.now();
      return super.startSession(config, events);
    }
  }
  const provider = new SlowProvider();
  let since = "";
  const s = setup({ provider, subscribeSpokenUpdates: (_cb, f) => { since = f.since; return () => {}; } });
  try {
    const before = Date.now();
    await s.orch.start();
    expect(Date.parse(since)).toBeLessThan(provider.openedAt);
    expect(Date.parse(since)).toBeGreaterThanOrEqual(before);
  } finally { await s.orch.close(); s.env.cleanup(); }
});

const row = (fields: Partial<WaitingEntryDto> & Pick<WaitingEntryDto, "kind" | "waiting">): WaitingEntryDto => ({
  key: `${fields.kind}:${fields.featureId ?? fields.threadId ?? "agent"}:${fields.waiting}`,
  threadId: null, threadTitle: null, featureId: null, workerName: null, text: "", place: null, ...fields
});

function source(listedAtStart: WaitingEntryDto[] = []) {
  const sse = new AgentSseEmitter();
  let listed = listedAtStart;
  /** What the global agent said at the end of each turn a notice or an alarm started, by wake. */
  const agentSaid = new Map<string, Array<{ key: string; text: string }>>();
  const start = startSpokenUpdateSource({
    sse,
    waiting: () => listed,
    globalThreadId: () => "g1",
    saidAfter: (query) => ("wakeId" in query ? agentSaid.get(query.wakeId) ?? [] : [])
  });
  /** The server lists `waiting` now. */
  const list = (waiting: WaitingEntryDto[]) => {
    listed = waiting;
    sse.emit(SSE_EVENTS.threadStatus, { threads: [], waiting });
  };
  return { sse, start, list, agentSaid };
}

test("the update source says what the agent said after a notice once, and each new Home row once; nothing after it stops", () => {
  const { sse, start, list, agentSaid } = source();
  agentSaid.set("w1", [{ key: "said:w1", text: "The search timeout is fixed." }]);
  const said: string[] = [];
  const stop = start((text) => said.push(text));
  const ended = (threadId: string, wakeId: string) => sse.emit(SSE_EVENTS.agentWakeFinished, { threadId, wakeId, status: "finished" });
  // Were this wake asked about, it would have something to say: it must not be.
  agentSaid.set("w9", [{ key: "said:w9", text: "words from another conversation" }]);
  ended("g1", "w1");
  ended("g1", "w1"); // told again
  ended("thr_other", "w9"); // another conversation's turn
  const broke = row({ kind: "thread", waiting: "failed", threadId: "t1", threadTitle: "Build docs", text: "boom" });
  const decide = row({ kind: "thread", waiting: "decision", threadId: "t2", threadTitle: "Pick a plan", text: "x" });
  const asks = row({ kind: "worker", waiting: "input", threadId: "t3", threadTitle: "Release", featureId: "f1", workerName: "fisher", text: "Tag it?" });
  // Your agent's own question is its own to say.
  const agentAsks = row({ kind: "agent", waiting: "input", text: "Now?" });
  list([broke]);
  list([broke, decide, asks, agentAsks]);
  list([broke, decide, asks, agentAsks]);
  list([row({ kind: "thread", waiting: "result", threadId: "t4", threadTitle: "Docs", text: "done" })]);
  expect(said).toStrictEqual([
    "The search timeout is fixed.", "Build docs: failed.", "Pick a plan: decision needed.", "Release: needs you.", "Docs: result to read."
  ]);
  stop();
  agentSaid.set("w2", [{ key: "said:w2", text: "one more sentence" }]);
  ended("g1", "w2");
  list([broke]);
  expect(said).toHaveLength(5);
});

test("what the agent said is clipped to what can be listened to", () => {
  const { sse, start, agentSaid } = source();
  agentSaid.set("w1", [{ key: "said:w1", text: "x".repeat(400) }]);
  const said: string[] = [];
  start((text) => said.push(text));
  sse.emit(SSE_EVENTS.agentWakeFinished, { threadId: "g1", wakeId: "w1", status: "finished" });
  expect(said.map((text) => [text.length, text.endsWith("…")])).toStrictEqual([[300, true]]);
});

test("a row already listed when the session opens is not announced, until it leaves and comes back", () => {
  const stuck = row({ kind: "thread", waiting: "stopped", threadId: "m1", threadTitle: "PR reviews", text: "it kept repeating" });
  const { start, list } = source([stuck]);
  const said: string[] = [];
  start((text) => said.push(text));
  list([stuck]); // marked seen, renamed …
  expect(said).toStrictEqual([]);
  list([]);
  list([stuck]);
  expect(said).toStrictEqual(["PR reviews: stopped."]);
});
