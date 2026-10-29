import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { loadConfig, type Config } from "../src/server/config.js";
import type { ThreadArchiveInput } from "../src/server/modules/agent/thread-archive.js";
import { freshStoresEnv } from "./helpers/fixtures.js";
import { toolContext } from "./helpers/typed.js";
import { testAgentRuntime } from "./helpers/agent-runtime.js";

// The runtime, not a tool built by hand: the archive the app makes reaches
// the global agent's own tool list, and no other agent's.
function runtimeWith(
  env: ReturnType<typeof freshStoresEnv>,
  threadArchive?: { archive: (input: ThreadArchiveInput) => Promise<{ ok: false; status: 404; error: string }> },
  config: Config = loadConfig(env.dir)
) {
  return testAgentRuntime(env, {
    // Never ready: no startup wake runs.
    config,
    threadArchive
  });
}

test("the global agent, and only it, is given archive_thread, and the tool reaches the app's archive", async () => {
  const env = freshStoresEnv("md-thread-archive-wiring-");
  const asked: ThreadArchiveInput[] = [];
  const runtime = runtimeWith(env, { archive: async (input) => { asked.push(input); return { ok: false, status: 404, error: "thread not found" }; } });
  try {
    const has = (scope: "global" | "manager" | "worker") => runtime.scopes[scope].toolDefinitions.some((tool) => tool.name === "archive_thread");
    expect({ global: has("global"), manager: has("manager"), worker: has("worker") }).toEqual({ global: true, manager: false, worker: false });
    const tool = runtime.scopes.global.toolDefinitions.find((candidate) => candidate.name === "archive_thread")!;
    expect(await tool.handler({ threadId: "thr_1", confirmedByUser: true }, toolContext({ threadId: "g1", wakeId: "w1" }))).toEqual({ error: "thread not found" });
    expect(asked).toStrictEqual([{ threadId: "thr_1", confirmed: [] }]);
  } finally {
    runtime.dispose();
    env.cleanup();
  }
});

test("an embedder with no archive gives the global agent no such tool", () => {
  const env = freshStoresEnv("md-thread-archive-wiring-none-");
  const runtime = runtimeWith(env);
  try {
    expect(runtime.scopes.global.toolDefinitions.some((tool) => tool.name === "archive_thread")).toBe(false);
    // Its other tools are there: it is this one that is missing.
    expect(runtime.scopes.global.toolDefinitions.some((tool) => tool.name === "send_to_thread")).toBe(true);
  } finally {
    runtime.dispose();
    env.cleanup();
  }
});

test("a thread whose memories are still being drawn from its window is at work until that call ends", async () => {
  const env = freshStoresEnv("md-thread-archive-extraction-");
  // The extraction model's endpoint: holds each call until it is let go.
  let release!: () => void;
  const released = new Promise<void>((resolve) => { release = resolve; });
  let calls = 0;
  const realFetch = globalThis.fetch;
  // The failed call is logged, by the SDK and by Mandate, with its whole request.
  const { warn: realWarn, error: realError } = console;
  console.warn = () => {};
  console.error = () => {};
  globalThis.fetch = Object.assign(async () => { calls += 1; await released; return new Response("{}", { status: 400 }); }, { preconnect: () => {} });
  fs.writeFileSync(path.join(env.dir, "config.json"), JSON.stringify({
    models: {
      default: { model: "local/model-1" },
      providers: { local: { type: "openai-compatible", apiKey: "test-key", baseURL: "http://model.test/v1", models: [{ id: "model-1", input: ["text"] }] } }
    }
  }));
  const runtime = runtimeWith(env, undefined, loadConfig(env.dir));
  try {
    const thread = env.agentStore.getOrCreateThread("manager", null);
    env.agentStore.appendMessage({ threadId: thread.id, role: "user", source: "user", content: { type: "text", text: "Commit messages in project-1 are written in English." } });
    expect(runtime.isThreadWorking(thread.id)).toBe(false);
    // Held as a turn holds it (a compaction started by hand does the same).
    const letGo = runtime.wakeScheduler.holdThread(thread.id)!;
    expect(runtime.isThreadWorking(thread.id)).toBe(true);
    letGo();
    expect(runtime.isThreadWorking(thread.id)).toBe(false);
    runtime.beforeThreadArchive(thread.id);
    // From the moment the archive hands the window over, before the call is made.
    expect(runtime.isThreadWorking(thread.id)).toBe(true);
    for (let i = 0; i < 200 && calls === 0; i++) await Bun.sleep(5);
    expect(calls).toBe(1);
    expect(runtime.isThreadWorking(thread.id)).toBe(true);
    release();
    for (let i = 0; i < 200 && runtime.isThreadWorking(thread.id); i++) await Bun.sleep(5);
    expect(runtime.isThreadWorking(thread.id)).toBe(false);
  } finally {
    release();
    globalThis.fetch = realFetch;
    console.warn = realWarn;
    console.error = realError;
    runtime.dispose();
    env.cleanup();
  }
});
