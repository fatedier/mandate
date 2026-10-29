import { afterEach, expect, test } from "bun:test";
import { WakeRuntimeContext, renderStateChanges } from "../src/server/modules/agent/wake-runtime-context.js";
import { freshStoresEnv, type StoresEnv } from "./helpers/fixtures.js";
import { testAgentRuntime } from "./helpers/agent-runtime.js";
import { prepareAiSdkMessages } from "../src/server/modules/agent/wake-message-adapter.js";

// Your agent's runtime digest, once its window has a full one, is sent as the
// changes since that digest: the lines added or gone under their sections.
// A full digest again once the changes sent since it would outweigh it.
// Other agents get the whole digest each time, as before.

let env: StoresEnv | null = null;
afterEach(() => { env?.cleanup(); env = null; });

const HEADER = "[runtime_context update]\nChanges since the last full digest above, by section: \"+\" lines are new or changed, \"-\" lines are gone or replaced; lines not listed stand as that digest has them. Not authoritative state; use tools for exact current state.";

const digest = (threads: string[], waiting: string[] = []) => [
  "## Global agent runtime context",
  "",
  "Your name: Atlas",
  "",
  "## Threads",
  "",
  ...threads.map((t) => `- ${t}`),
  ...(waiting.length > 0 ? ["", "## Waiting on the user", "", ...waiting.map((w) => `- ${w}`)] : [])
].join("\n");

function setup(changesOnly: (threadId: string) => boolean, initial: { context?: string; tasks?: string } = {}) {
  env = freshStoresEnv("md-runtime-context-changes-");
  const e = env;
  let state = digest(["Docs overhaul · working", "Release dates · idle"]);
  const context = new WakeRuntimeContext({
    agentStore: e.agentStore,
    buildSystemPrompt: () => "SYSTEM",
    buildRuntimeContext: () => state,
    contextChangesOnly: changesOnly,
    ...(initial.context ? { buildInitialContext: () => initial.context! } : {}),
    ...(initial.tasks ? { buildTasksContext: () => initial.tasks! } : {})
  });
  const thread = e.agentStore.getOrCreateGlobalThread();
  /** One wake of the thread: its context brought up to date. */
  const wake = async (threadId = thread.id) => {
    const w = e.agentStore.createWake({ threadId, reason: "user", triggerMessageId: null });
    context.begin(w.id);
    await context.ensurePromptContextMessages(threadId, w.id);
    context.end(w.id);
  };
  const contexts = (threadId = thread.id) => e.agentStore.getActiveMessages(threadId)
    .filter((m) => m.source === "runtime-context")
    .map((m) => (m.content.type === "text" ? m.content.text : ""));
  return { e, thread, wake, contexts, set: (next: string) => { state = next; } };
}

test("Your agent's digest, changed, is sent as the changes since its window's full one", async () => {
  const s = setup(() => true);
  // Threads that stay as they are: the digest is larger than what changes in it.
  const quiet = Array.from({ length: 8 }, (_, i) => `Archive pass ${i} · idle · 0 workers`);
  s.set(digest(["Docs overhaul · working", "Release dates · idle", ...quiet]));
  await s.wake();
  expect(s.contexts()).toHaveLength(1);
  expect(s.contexts()[0]).toContain("[initial_context]");
  s.set(digest(["Docs overhaul · result to read", "Release dates · idle", ...quiet], ["question · Release dates · \"The 12th or the 19th?\""]));
  await s.wake();
  expect(s.contexts()[1]).toBe([
    HEADER,
    "",
    "## Threads",
    "- Docs overhaul · working",
    "+ Docs overhaul · result to read",
    "",
    "## Waiting on the user",
    "+ question · Release dates · \"The 12th or the 19th?\""
  ].join("\n"));
  // Unchanged: nothing more.
  await s.wake();
  expect(s.contexts()).toHaveLength(2);
  // Changed again: the changes since the full digest, not since the last changes.
  s.set(digest(["Docs overhaul · working", "Release dates · idle", ...quiet]));
  await s.wake();
  expect(s.contexts()[2]).toBe(HEADER);
});

test("once the changes sent since the full digest would outweigh it, a full digest goes again, and the changes count from it", async () => {
  const s = setup(() => true);
  const threads = (run: number, idle: number[] = []) => Array.from({ length: 12 }, (_, i) => `Thread ${i} · ${idle.includes(i) ? "idle" : "working"} · run ${run}`);
  s.set(digest(threads(1)));
  await s.wake();
  s.set(digest(threads(1, [0])));
  await s.wake();
  expect(s.contexts()[1]).toBe([HEADER, "", "## Threads", "- Thread 0 · working · run 1", "+ Thread 0 · idle · run 1"].join("\n"));
  // Every thread changed: more than the full digest itself since it, so the whole of it again.
  s.set(digest(threads(2)));
  await s.wake();
  expect(s.contexts()[2]!.startsWith("[runtime_context]\n")).toBe(true);
  expect(s.contexts()[2]).toContain("- Thread 11 · working · run 2");
  s.set(digest(threads(2, [11])));
  await s.wake();
  expect(s.contexts()[3]).toBe([HEADER, "", "## Threads", "- Thread 11 · working · run 2", "+ Thread 11 · idle · run 2"].join("\n"));
});

test("other agents get the whole digest each time, as before", async () => {
  const s = setup((threadId) => threadId === "nobody");
  await s.wake();
  s.set(digest(["Docs overhaul · result to read", "Release dates · idle"]));
  await s.wake();
  expect(s.contexts()[1]!.startsWith("[runtime_context]\n")).toBe(true);
  expect(s.contexts()[1]).toContain("- Release dates · idle");
});

test("a window whose last full digest an older version wrote gets a full digest first", async () => {
  const s = setup(() => true);
  // An older version's initial context: no state kept beside it.
  s.e.agentStore.appendMessage({ threadId: s.thread.id, role: "user", source: "runtime-context", content: { type: "text", text: `[initial_context]\nBaseline.\n\n${digest(["Docs overhaul · working"])}`, metadata: { runtimeContextKind: "initial", runtimeStateHash: "old" } } });
  await s.wake();
  expect(s.contexts()[1]!.startsWith("[runtime_context]\n")).toBe(true);
  s.set(digest(["Docs overhaul · working", "Release dates · result to read"]));
  await s.wake();
  expect(s.contexts()[2]).toBe([HEADER, "", "## Threads", "- Release dates · idle", "+ Release dates · result to read"].join("\n"));
});

test("changes are read by section: a line repeated counts each time, a section gone lists what it held, lines before any heading are a section too", () => {
  const before = ["Your name: Atlas", "", "## Threads", "- a · idle", "- a · idle", "- b · idle", "", "## Workers", "- w1 · thread: a"].join("\n");
  const after = ["Your name: Juno", "", "## Threads", "- a · idle", "- b · working"].join("\n");
  expect(renderStateChanges(before, after)).toBe([
    "- Your name: Atlas",
    "+ Your name: Juno",
    "",
    "## Threads",
    "- a · idle",
    "- b · idle",
    "+ b · working",
    "",
    "## Workers",
    "- w1 · thread: a"
  ].join("\n"));
  expect(renderStateChanges(before, before)).toBe("");
  // A line moved, unchanged, to another section: gone from one, added to the other.
  const moved = renderStateChanges(["## Waiting", "- release notes", "## Done", "- docs"].join("\n"), ["## Waiting", "## Done", "- docs", "- release notes"].join("\n"));
  expect(moved).toBe(["## Waiting", "- release notes", "", "## Done", "+ release notes"].join("\n"));
  // A section renamed with its lines: all of them under the new heading, none under the old.
  expect(renderStateChanges(["## Friday", "- call the vendor"].join("\n"), ["## Monday", "- call the vendor"].join("\n")))
    .toBe(["## Monday", "+ call the vendor", "", "## Friday", "- call the vendor"].join("\n"));
});

test("the runtime sends changes for Your agent's conversation only", () => {
  env = freshStoresEnv("md-runtime-context-changes-wiring-");
  const runtime = testAgentRuntime(env);
  try {
    const deps = (runtime.wakeScheduler as unknown as { deps: { contextChangesOnly?: (threadId: string) => boolean } }).deps;
    const global = env.agentStore.getOrCreateGlobalThread();
    const manager = env.agentStore.createManagerThread("Docs overhaul");
    expect([deps.contextChangesOnly?.(global.id), deps.contextChangesOnly?.(manager.id)]).toEqual([true, false]);
  } finally {
    runtime.dispose();
  }
});

test("small changes that together outweigh the full digest bring a full digest again", async () => {
  const s = setup(() => true);
  const quiet = Array.from({ length: 8 }, (_, i) => `Archive pass ${i} · idle · 0 workers`);
  s.set(digest(["Docs overhaul · working", ...quiet]));
  await s.wake();
  // One thread goes back and forth between two states, neither the full digest's:
  // each change is two lines, but they add up.
  const kinds: string[] = [];
  for (let i = 0; i < 12; i++) {
    s.set(digest([`Docs overhaul · ${i % 2 === 0 ? "result to read" : "decision needed"}`, ...quiet]));
    await s.wake();
    kinds.push(s.contexts().at(-1)!.split("\n")[0]!);
  }
  const firstFull = kinds.indexOf("[runtime_context]");
  // Changes first, a full digest once they outweigh it, then changes again counted from it.
  expect(firstFull).toBeGreaterThan(1);
  expect(kinds.slice(0, firstFull).every((kind) => kind === "[runtime_context update]")).toBe(true);
  expect(kinds[firstFull + 1]).toBe("[runtime_context update]");
});

test("in a first context holding more than the digest, only the digest is what changes are read against", async () => {
  const s = setup(() => true, { context: "## Skills\n\n- web_search", tasks: "## Running tasks\n\n- build · running" });
  const quiet = Array.from({ length: 8 }, (_, i) => `Archive pass ${i} · idle · 0 workers`);
  s.set(digest(["Docs overhaul · working", ...quiet]));
  await s.wake();
  expect(s.contexts()[0]).toContain("## Skills");
  s.set(digest(["Docs overhaul · result to read", ...quiet]));
  await s.wake();
  expect(s.contexts()[1]).toBe([HEADER, "", "## Threads", "- Docs overhaul · working", "+ Docs overhaul · result to read"].join("\n"));
});

test("a change only to a section's heading, with nothing under it, goes as a full digest: changes could not show it", async () => {
  const s = setup(() => true);
  const quiet = Array.from({ length: 8 }, (_, i) => `Archive pass ${i} · idle · 0 workers`);
  s.set(`${digest(quiet)}\n\n## Follow up Friday`);
  await s.wake();
  s.set(`${digest(quiet)}\n\n## Follow up Monday`);
  await s.wake();
  expect(s.contexts()[1]!.startsWith("[runtime_context]\n")).toBe(true);
  expect(s.contexts()[1]).toContain("## Follow up Monday");
});

test("a digest whose headings repeat (the notes may reuse one) goes whole: changes could not say which section", async () => {
  const s = setup(() => true);
  const quiet = Array.from({ length: 8 }, (_, i) => `Archive pass ${i} · idle · 0 workers`);
  const notes = (first: string[], second: string[]) => ["## Your notes", ...first.map((l) => `- ${l}`), "## Your notes", ...second.map((l) => `- ${l}`)].join("\n");
  s.set(`${digest(quiet)}\n\n${notes(["a", "b"], [])}`);
  await s.wake();
  // A line moves from one notes section to the other.
  s.set(`${digest(quiet)}\n\n${notes(["a"], ["b"])}`);
  await s.wake();
  expect(s.contexts()[1]!.startsWith("[runtime_context]\n")).toBe(true);
});

test("the model reads the full digest and every change after it, and after a new first context only that and what follows", async () => {
  const s = setup(() => true);
  const quiet = Array.from({ length: 8 }, (_, i) => `Archive pass ${i} · idle · 0 workers`);
  const seen = () => prepareAiSdkMessages(s.e.agentStore.getActiveMessages(s.thread.id), { includeImages: false })
    .filter((m) => m.role === "user")
    .map((m) => (typeof m.content === "string" ? m.content : m.content.map((part) => (part.type === "text" ? part.text : "")).join("")))
    .filter((text) => text.startsWith("[initial_context]") || text.startsWith("[runtime_context"))
    .map((text) => text.split("\n")[0]);
  s.set(digest(["Docs overhaul · working", ...quiet]));
  await s.wake();
  s.set(digest(["Docs overhaul · result to read", ...quiet]));
  await s.wake();
  s.set(digest(["Docs overhaul · decision needed", ...quiet]));
  await s.wake();
  expect(seen()).toEqual(["[initial_context]", "[runtime_context update]", "[runtime_context update]"]);
  // A new window's first context, as a compaction leaves it: the changes count from it.
  s.e.agentStore.appendMessage({
    threadId: s.thread.id, role: "user", source: "runtime-context",
    content: { type: "text", text: `[initial_context]\nBaseline.\n\n${digest(["Docs overhaul · decision needed", ...quiet])}`, metadata: { runtimeContextKind: "initial", runtimeStateHash: "fresh", runtimeStateBody: digest(["Docs overhaul · decision needed", ...quiet]) } }
  });
  s.set(digest(["Docs overhaul · idle", ...quiet]));
  await s.wake();
  expect(seen()).toEqual(["[initial_context]", "[runtime_context update]"]);
  expect(s.contexts().at(-1)).toBe([HEADER, "", "## Threads", "- Docs overhaul · decision needed", "+ Docs overhaul · idle"].join("\n"));
});
