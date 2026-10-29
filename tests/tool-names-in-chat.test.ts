import { expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { buildCommonToolPacks, buildManagerToolPacks, buildWorkerToolPacks } from "../src/server/modules/registry.js";
import { buildGlobalActionTools, buildGlobalReadTools } from "../src/server/modules/global/global-tools.js";
import type { MandateStore } from "../src/server/app/store.js";
import type { SkillRegistry } from "../src/server/modules/skills/skill-registry.js";
import type { WindowWatchManager } from "../src/server/modules/agent/window-watch-manager.js";
import type { MemoryManager } from "../src/server/modules/memory/manager.js";
import type { AgentStore } from "../src/server/modules/agent/agent-store.js";
import type { FeaturesStore } from "../src/server/modules/features/features-store.js";
import type { WakeScheduler } from "../src/server/modules/agent/wake-loop.js";
import type { ManagerToolPackContext, WorkerToolPackContext } from "../src/server/modules/module.js";
import type { HandoffService } from "../src/server/modules/global/handoff-service.js";
import { describeCall } from "../src/client/routes/window/chat/tool-run-summary.js";
import { toolKind } from "../src/client/routes/window/chat/tool-kind.js";
import type { ProjectsStore } from "../src/server/modules/projects/projects-store.js";
import type { WorkItemStore } from "../src/server/modules/agent/work-item-store.js";
import type { CommandMonitorManager } from "../src/server/modules/agent/command-monitor-manager.js";
import type { AgentAlarmManager } from "../src/server/modules/agent/agent-alarm-manager.js";
import type { SweepController } from "../src/server/modules/agent/tools/sweep-tools.js";
import type { CanvasStore } from "../src/server/modules/canvas/canvas-store.js";
import type { AgentSseEmitter } from "../src/server/modules/sse/sse-events.js";
import type { PaneMetadataStore } from "../src/server/modules/panes/pane-metadata-store.js";
import { stub } from "./helpers/typed.js";
import { createWebTools } from "../src/server/modules/web/web-tools.js";
import { DEFAULT_CONFIG } from "../src/server/config/defaults.js";

// Every tool a chat can show a call of — the worker's, the manager's and the
// global agent's, built as agent-scopes builds them (stubs where a pack only
// needs a dependency to exist) — read back by the page as words and an icon,
// never as its raw name. The memory dreamer's tools are not here: its runs
// are not a conversation anyone reads.
function chatToolNames(): string[] {
  const common = (scope: "manager" | "worker") => buildCommonToolPacks({
    scope,
    store: stub<MandateStore>({ db: stub<Database>() }),
    skillRegistry: stub<SkillRegistry>(),
    watchManager: stub<WindowWatchManager>(),
    memory: stub<MemoryManager>(),
    agentStore: stub<AgentStore>(),
    projectsStore: stub<ProjectsStore>(),
    featuresStore: stub<FeaturesStore>(),
    workStore: stub<WorkItemStore>(),
    commandMonitorManager: stub<CommandMonitorManager>(),
    alarmManager: stub<AgentAlarmManager>(),
    sweepController: stub<SweepController>(),
    canvasStore: stub<CanvasStore>(),
    sse: stub<AgentSseEmitter>(),
    paneMetadata: stub<PaneMetadataStore>(),
    getWakeScheduler: () => stub<WakeScheduler>(),
    // web_search is offered only while it is set up.
    web: createWebTools({ getConfig: () => ({ ...structuredClone(DEFAULT_CONFIG), webSearch: { use: "exa", kinds: { exa: { apiKey: "k" } } } }) })
  });
  const packs = [
    ...common("worker"),
    ...common("manager"),
    ...buildWorkerToolPacks(stub<WorkerToolPackContext>()),
    ...buildManagerToolPacks(stub<ManagerToolPackContext>())
  ];
  const global = [
    ...buildGlobalReadTools(stub<Parameters<typeof buildGlobalReadTools>[0]>({ agentStore: stub<AgentStore>() })),
    ...buildGlobalActionTools({ handoffs: stub<HandoffService>() })
  ];
  return [...new Set([...packs.flatMap((pack) => pack.tools.map((t) => t.name)), ...global.map((t) => t.name)])].sort();
}

test("every tool a chat can show reads as what it did, with an icon of its kind", () => {
  const names = chatToolNames();
  // Positive control: the list holds all three agents' tools.
  for (const name of ["bash", "create_feature", "list_threads", "canvas_create", "web_search", "web_fetch"]) expect([name, names.includes(name)]).toEqual([name, true]);
  const missing = names.filter((name) => {
    const phrase = describeCall({ call: { toolCallId: name, toolName: name, args: {} }, result: null, isRunning: false });
    return phrase.leadIsToolName || toolKind(name, {}) === "tool";
  });
  expect(missing).toEqual([]);
});

// An agent could move the user's page (ui_navigate, canvas_open), open a link
// in it (ui_open_url) and ask it what it showed (ui_read_page_summary). All of
// that is gone: what an agent wants seen it says, or shows as a card the user
// opens.
test("no agent has a tool that moves, opens or reads the user's page", () => {
  const names = chatToolNames();
  expect(names.filter((name) => name.startsWith("ui_") || name === "canvas_open")).toEqual([]);
  // Positive control: the canvas tools that remain are in the list.
  expect(names.filter((name) => name.startsWith("canvas_"))).toEqual([
    "canvas_create", "canvas_outline", "canvas_publish", "canvas_read", "canvas_remove_section", "canvas_update"
  ]);
});
