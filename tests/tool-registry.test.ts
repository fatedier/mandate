import { expect, test } from "bun:test";
import * as fs from "node:fs";
import { z } from "zod";
import { ToolRegistry, ToolDispatcher, type ToolDefinition } from "../src/server/modules/agent/tool-registry.js";
import { withTempDataDir } from "./helpers/fixtures.js";
import { stub, toolContext } from "./helpers/typed.js";
import type { ProjectRow, ProjectsStore } from "../src/server/modules/projects/projects-store.js";
import { buildManagerScope } from "../src/server/runtime/scopes/manager-scope.js";
import { buildWorkerScope } from "../src/server/runtime/scopes/worker-scope.js";
import { buildSubagentScope } from "../src/server/runtime/scopes/subagent-scope.js";
import { buildGlobalScope } from "../src/server/modules/global/global-scope.js";
import { toolPack } from "../src/server/runtime/tool-packs.js";
import { SkillRegistry } from "../src/server/modules/skills/skill-registry.js";
import { DEFAULT_CONFIG } from "../src/server/config/defaults.js";
import type { AgentScope, AgentStore, AgentThread } from "../src/server/modules/agent/agent-store.js";
import type { FeaturesStore } from "../src/server/modules/features/features-store.js";
import type { Analyzer } from "../src/server/modules/analysis/analyzer.js";
import type { TmuxClient } from "../src/server/platform/tmux/tmux.js";
import type { PaneRuntimeRegistry } from "../src/server/runtime/pane-runtime-registry.js";
import type { WorkItemStore } from "../src/server/modules/agent/work-item-store.js";
import type { PlanStore } from "../src/server/modules/plans/plan-store.js";
import type { BackgroundTaskStore } from "../src/server/modules/agent/background-task-store.js";
import type { AgentScope as AgentToolScope } from "../src/server/modules/agent/tool-scope.js";
import type { ScopeRuntime } from "../src/server/runtime/scope.js";
import { FeatureRecordStore } from "../src/server/modules/plans/record-store.js";

test("ToolRegistry.register: stores tool definitions; AI SDK tools shape correct", () => {
  const reg = new ToolRegistry();
  reg.register({
    name: "echo", description: "Echo input",
    parameters: z.object({ text: z.string() }),
    handler: async ({ text }) => ({ echoed: text })
  });
  expect(reg.tools.echo).toBeTruthy();
  // execute is intentionally NOT defined: our wake-loop dispatches tools manually
  // to avoid double-execution (AI SDK would also call execute automatically).
  expect(typeof reg.tools.echo.execute).toBe("undefined");
  expect(reg.tools.echo.description).toBe("Echo input");
});

test("ToolDispatcher: dispatches successful tool call", async () => {
  const reg = new ToolRegistry();
  reg.register({
    name: "add", description: "Add",
    parameters: z.object({ a: z.number(), b: z.number() }),
    handler: async ({ a, b }) => ({ sum: a + b })
  });
  const dispatcher = new ToolDispatcher(reg);
  const r = await dispatcher.dispatch(
    { toolCallId: "c1", toolName: "add", args: { a: 2, b: 3 } },
    { threadId: "t", wakeId: "w", scope: { kind: "manager", managerDir: "", projectWorkingDirs: [] } }
  );
  expect(r).toEqual({ result: { sum: 5 } });
});

test("ToolDispatcher: catches handler error, returns isError result", async () => {
  const reg = new ToolRegistry();
  reg.register({
    name: "fail", description: "Always fails",
    parameters: z.object({}),
    handler: async () => { throw new Error("boom"); }
  });
  const dispatcher = new ToolDispatcher(reg);
  const r = await dispatcher.dispatch(
    { toolCallId: "c1", toolName: "fail", args: {} },
    { threadId: "t", wakeId: "w", scope: { kind: "manager", managerDir: "", projectWorkingDirs: [] } }
  );
  expect(r.isError).toBe(true);
  expect(r.error!).toMatch(/boom/);
});

test("ToolDispatcher: rejects unknown tool name", async () => {
  const reg = new ToolRegistry();
  const dispatcher = new ToolDispatcher(reg);
  const r = await dispatcher.dispatch(
    { toolCallId: "c1", toolName: "ghost", args: {} },
    { threadId: "t", wakeId: "w", scope: { kind: "manager", managerDir: "", projectWorkingDirs: [] } }
  );
  expect(r.isError).toBe(true);
  expect(r.error!).toMatch(/unknown tool/i);
});

test("ToolDispatcher: validates args against zod schema", async () => {
  const reg = new ToolRegistry();
  reg.register({
    name: "needsString", description: "Needs string",
    parameters: z.object({ s: z.string() }),
    handler: async ({ s }) => ({ ok: s })
  });
  const dispatcher = new ToolDispatcher(reg);
  const r = await dispatcher.dispatch(
    { toolCallId: "c1", toolName: "needsString", args: { s: 123 } },
    { threadId: "t", wakeId: "w", scope: { kind: "manager", managerDir: "", projectWorkingDirs: [] } }
  );
  expect(r.isError).toBe(true);
  expect(r.error!).toMatch(/validation|expected string/i);
});

test("ToolDispatcher: persists large text results under Mandate data dir", async () => {
  const { dataDir, restore } = withTempDataDir();
  const reg = new ToolRegistry();
  const large = "x".repeat(70 * 1024);
  reg.register({
    name: "largeText",
    description: "Large text",
    parameters: z.object({}),
    handler: async () => large
  });

  try {
    const dispatcher = new ToolDispatcher(reg);
    const r = await dispatcher.dispatch(
      { toolCallId: "call/1", toolName: "largeText", args: {} },
      toolContext({ threadId: "thread/1", wakeId: "wake/1" })
    );
    const text = r.result as string;
    expect(text).toContain("<persisted-output>");
    expect(text).toContain("Use read with this path");

    const outputPath = text.split("\n").find((line) => line.startsWith(dataDir));
    expect(outputPath).toBeTruthy();
    expect(outputPath).toContain("resources/global/tool-output/thread_1/");
    expect(fs.readFileSync(outputPath!, "utf8")).toBe(large);
  } finally {
    restore();
  }
});

test("ToolDispatcher: persists project tool output under project resources", async () => {
  const { dataDir, restore } = withTempDataDir();
  const reg = new ToolRegistry();
  const large = "y".repeat(70 * 1024);
  reg.register({
    name: "largeText",
    description: "Large text",
    parameters: z.object({}),
    handler: async () => large
  });

  try {
    const dispatcher = new ToolDispatcher(reg);
    const r = await dispatcher.dispatch(
      { toolCallId: "call-1", toolName: "largeText", args: {} },
      toolContext({
        threadId: "thread-1",
        wakeId: "wake-1",
        project: stub<ProjectRow>({ id: "proj-1" })
      })
    );
    const text = r.result as string;
    const outputPath = text.split("\n").find((line) => line.startsWith(dataDir));
    expect(outputPath).toContain("resources/projects/proj-1/tool-output/thread-1/");
    expect(fs.readFileSync(outputPath!, "utf8")).toBe(large);
  } finally {
    restore();
  }
});

// One rule for every tool: past 30,000 characters of what the model would
// get, the whole goes to a file and the model gets the first 2,000 and the
// path.
async function dispatchResult(result: unknown) {
  const reg = new ToolRegistry();
  reg.register({ name: "out", description: "out", parameters: z.object({}), handler: async () => result });
  const r = await new ToolDispatcher(reg).dispatch(
    { toolCallId: "call-1", toolName: "out", args: {} },
    toolContext({ threadId: "thread-1", wakeId: "wake-1" })
  );
  return r.result;
}
const savedPathOf = (text: string, dataDir: string) => text.split("\n").find((line) => line.startsWith(dataDir));

test("a text result over 30,000 characters is saved whole; the model gets its first 2,000 and the path", async () => {
  const { dataDir, restore } = withTempDataDir();
  try {
    const long = Array.from({ length: 30_001 }, (_, i) => String.fromCharCode(97 + (i % 26))).join("");
    const text = await dispatchResult(long) as string;
    expect(text.startsWith("<persisted-output>\nOutput too large (")).toBe(true);
    expect(fs.readFileSync(savedPathOf(text, dataDir)!, "utf8")).toBe(long);
    expect(text).toContain(`Preview (first 2,000 characters):\n${long.slice(0, 2000)}\n</persisted-output>`);
    expect(text).not.toContain(long.slice(0, 2001));
  } finally { restore(); }
});

test("a text result of 30,000 characters, or of many short lines under it, reaches the model whole", async () => {
  const { restore } = withTempDataDir();
  try {
    const exact = "x".repeat(30_000);
    expect(await dispatchResult(exact)).toBe(exact);
    const lines = Array.from({ length: 2500 }, (_, i) => `l${i}`).join("\n");
    expect(lines.length).toBeLessThan(30_000);
    expect(await dispatchResult(lines)).toBe(lines);
  } finally { restore(); }
});

test("an object result over 30,000 serialized characters is saved as its JSON, as the model would read it", async () => {
  const { dataDir, restore } = withTempDataDir();
  try {
    const messages = Array.from({ length: 12 }, (_, i) => ({ seq: i, role: "assistant", text: `${i} ${"m".repeat(3000)}` }));
    const text = await dispatchResult({ messages }) as string;
    expect(typeof text).toBe("string");
    expect(text.startsWith("<persisted-output>\n")).toBe(true);
    // Saved indented, so the file reads in pages of lines.
    expect(fs.readFileSync(savedPathOf(text, dataDir)!, "utf8")).toBe(JSON.stringify({ messages }, null, 2));
    // A small object is left as it is.
    expect(await dispatchResult({ messages: messages.slice(0, 2) })).toEqual({ messages: messages.slice(0, 2) });
  } finally { restore(); }
});

test("an image result is never cut, however long its data", async () => {
  const { restore } = withTempDataDir();
  try {
    const image = {
      type: "view_image_result",
      message: "Viewed shot.png",
      image: { type: "image", id: "img_1", name: "shot.png", displayPath: "shot.png", mediaType: "image/png", sizeBytes: 60_000, data: "A".repeat(80_000) }
    };
    expect(await dispatchResult(image)).toEqual(image);
  } finally { restore(); }
});

function tool(name: string, available?: () => boolean): ToolDefinition {
  return { name, description: name, parameters: z.object({}), handler: async () => name, ...(available ? { available } : {}) };
}

test("a tool whose availability is off is neither offered, listed nor run", async () => {
  let on = false;
  const registry = new ToolRegistry();
  registry.register(tool("always"));
  registry.register(tool("sometimes", () => on));
  const dispatcher = new ToolDispatcher(registry);
  expect(Object.keys(registry.tools)).toEqual(["always"]);
  expect(registry.definitions.map((d) => d.name)).toEqual(["always"]);
  expect(registry.getDefinition("sometimes")).toBeNull();
  expect(await dispatcher.dispatch({ toolCallId: "c", toolName: "sometimes", args: {} }, toolContext({})))
    .toEqual({ isError: true, error: "unknown tool: sometimes" });
  on = true;
  expect(Object.keys(registry.tools)).toEqual(["always", "sometimes"]);
  expect(registry.definitions.map((d) => d.name)).toEqual(["always", "sometimes"]);
  expect((await dispatcher.dispatch({ toolCallId: "c", toolName: "sometimes", args: {} }, toolContext({}))).result).toBe("sometimes");
});

test("the tool set keeps its identity while nothing changes, and changes when availability does", () => {
  let on = true;
  const registry = new ToolRegistry();
  registry.register(tool("a"));
  registry.register(tool("b", () => on));
  const first = registry.tools;
  expect(registry.tools).toBe(first);
  on = false;
  const second = registry.tools;
  expect(second).not.toBe(first);
  expect(Object.keys(second)).toEqual(["a"]);
  // The tool objects themselves are the ones built at registration.
  expect(second.a).toBe(first.a);
});

const PARENT: Pick<AgentThread, "id" | "scope" | "scopeId"> = { id: "thr_parent", scope: "manager", scopeId: null };

function builtScopes(flagged: ToolDefinition): Array<{ scope: ScopeRuntime; threadId: string }> {
  const pack = (scope: AgentScope) => [toolPack(`test.${scope}`, [scope], [flagged])];
  const manager = buildManagerScope({
    agentStore: stub<AgentStore>(), projectsStore: stub<ProjectsStore>(), featuresStore: stub<FeaturesStore>(),
    skillRegistry: new SkillRegistry(), records: stub<FeatureRecordStore>(), toolPacks: pack("manager")
  });
  const worker = buildWorkerScope({
    agentStore: stub<AgentStore>(), projectsStore: stub<ProjectsStore>(), featuresStore: stub<FeaturesStore>(),
    analyzer: stub<Analyzer>(), tmuxClient: stub<TmuxClient>(), paneRuntimes: stub<PaneRuntimeRegistry>(),
    skillRegistry: new SkillRegistry(), records: stub<FeatureRecordStore>(), toolPacks: pack("worker")
  });
  const global = buildGlobalScope({
    getConfig: () => structuredClone(DEFAULT_CONFIG),
    agentStore: stub<AgentStore>(), projectsStore: stub<ProjectsStore>(), featuresStore: stub<FeaturesStore>(),
    workStore: stub<WorkItemStore>(), planStore: stub<PlanStore>(), skillRegistry: new SkillRegistry(), memory: null, records: stub<FeatureRecordStore>(),
    toolPacks: pack("global")
  });
  const subagentPack = toolPack("test.subagent", ["subagent"], [flagged]);
  const subagent = buildSubagentScope({
    agentStore: stub<AgentStore>({ getThreadById: (id: string) => (id === PARENT.id ? (PARENT as AgentThread) : null) }),
    backgroundTasks: stub<BackgroundTaskStore>({
      getByChildThread: (id: string) => (id === "thr_child" ? ({ parentThreadId: PARENT.id } as ReturnType<BackgroundTaskStore["getByChildThread"]>) : null)
    }),
    featuresStore: stub<FeaturesStore>(), projectsStore: stub<ProjectsStore>(),
    toolPacks: { worker: subagentPack, manager: subagentPack, global: subagentPack },
    parentToolScope: () => stub<AgentToolScope>()
  });
  return [
    { scope: manager, threadId: "thr_m" },
    { scope: worker, threadId: "thr_w" },
    { scope: global, threadId: "thr_g" },
    { scope: subagent, threadId: "thr_child" }
  ];
}

test("each scope offers what is available at the time it is asked", () => {
  let on = false;
  const scopes = builtScopes(tool("flagged", () => on));
  const offered = ({ scope, threadId }: { scope: ScopeRuntime; threadId: string }) =>
    Object.keys((scope.dispatcherForThread?.(threadId) ?? scope.wrappedDispatcher).registry.tools).includes("flagged");
  const listed = ({ scope }: { scope: ScopeRuntime }) => scope.toolDefinitions.some((d) => d.name === "flagged");
  expect(scopes.map((s) => [s.scope.scope, offered(s)])).toEqual([["manager", false], ["worker", false], ["global", false], ["subagent", false]]);
  // A subagent lists nothing of its own: its tools are its parent's.
  expect(scopes.map((s) => [s.scope.scope, listed(s)])).toEqual([["manager", false], ["worker", false], ["global", false], ["subagent", false]]);
  on = true;
  expect(scopes.map((s) => [s.scope.scope, offered(s)])).toEqual([["manager", true], ["worker", true], ["global", true], ["subagent", true]]);
  expect(scopes.map((s) => [s.scope.scope, listed(s)])).toEqual([["manager", true], ["worker", true], ["global", true], ["subagent", false]]);
});
