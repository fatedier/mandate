import { expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { buildCommonToolPacks, buildManagerToolPacks, buildWorkerToolPacks } from "../src/server/modules/registry.js";
import { buildPersonalActionTools, buildPersonalReadTools } from "../src/server/modules/personal/personal-tools.js";
import type { MandateStore } from "../src/server/app/store.js";
import type { SkillRegistry } from "../src/server/modules/skills/skill-registry.js";
import type { PaneMonitorManager } from "../src/server/modules/agent/pane-monitor-manager.js";
import type { MemoryManager } from "../src/server/modules/memory/manager.js";
import type { AgentStore } from "../src/server/modules/agent/agent-store.js";
import type { WorkersStore } from "../src/server/modules/workers/workers-store.js";
import type { WakeScheduler } from "../src/server/modules/agent/wake-loop.js";
import type { ManagerToolPackContext, WorkerToolPackContext } from "../src/server/modules/module.js";
import type { HandoffService } from "../src/server/modules/personal/handoff-service.js";
import { describeCall } from "../src/client/routes/window/chat/tool-run-summary.js";
import { toolKind } from "../src/client/routes/window/chat/tool-kind.js";
import type { ProjectsStore } from "../src/server/modules/projects/projects-store.js";
import type { WorkItemStore } from "../src/server/modules/agent/work-item-store.js";
import type { CommandMonitorManager } from "../src/server/modules/agent/command-monitor-manager.js";
import type { AgentAlarmManager } from "../src/server/modules/agent/agent-alarm-manager.js";
import type { SweepController } from "../src/server/modules/agent/tools/sweep-tools.js";
import type { CanvasStore } from "../src/server/modules/canvas/canvas-store.js";
import type { AgentSseEmitter } from "../src/server/modules/sse/sse-events.js";
import { stub } from "./helpers/typed.js";
import { createWebTools } from "../src/server/modules/web/web-tools.js";
import { DEFAULT_CONFIG } from "../src/server/config/defaults.js";
import { buildScheduleTools } from "../src/server/modules/schedules/tools/schedule-tools.js";
import { buildNotifyTool } from "../src/server/modules/notifications/notify-tool.js";
import { buildPersonalSubagentTool, buildSubagentTools } from "../src/server/modules/agent/tools/subagent-tools.js";
import { buildQuestionTools } from "../src/server/modules/agent/tools/question-tools.js";
import { buildSkillTool } from "../src/server/modules/skills/skill-tool.js";
import { buildTaskBoardTools } from "../src/server/modules/task-board/tools/task-board-tools.js";
import { buildStickyNotesTools } from "../src/server/modules/sticky-notes/tools/sticky-notes-tools.js";
import { buildCalendarTools } from "../src/server/modules/calendar/tools/calendar-tools.js";

// Every tool a chat can show a call of — the worker's, the manager's and the
// personal agent's: the module packs, built as agent-scopes builds them, and
// the tools each scope adds of its own (stubs where a builder only needs a
// dependency to exist) — read back by the page as words and an icon, never
// as its raw name. The memory dreamer's tools are not here: its runs are not
// a conversation anyone reads.
function chatToolNames(): string[] {
  const common = (scope: "manager" | "worker") => buildCommonToolPacks({
    scope,
    store: stub<MandateStore>({ db: stub<Database>() }),
    skillRegistry: stub<SkillRegistry>(),
    paneMonitorManager: stub<PaneMonitorManager>(),
    memory: stub<MemoryManager>(),
    agentStore: stub<AgentStore>(),
    projectsStore: stub<ProjectsStore>(),
    workersStore: stub<WorkersStore>(),
    workStore: stub<WorkItemStore>(),
    commandMonitorManager: stub<CommandMonitorManager>(),
    alarmManager: stub<AgentAlarmManager>(),
    sweepController: stub<SweepController>(),
    canvasStore: stub<CanvasStore>(),
    sse: stub<AgentSseEmitter>(),
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
  const personal = [
    ...buildPersonalReadTools(stub<Parameters<typeof buildPersonalReadTools>[0]>({ agentStore: stub<AgentStore>() })),
    ...buildPersonalActionTools({ handoffs: stub<HandoffService>() }),
    ...buildScheduleTools(stub<Parameters<typeof buildScheduleTools>[0]>()),
    ...buildTaskBoardTools(stub<Parameters<typeof buildTaskBoardTools>[0]>()),
    ...buildStickyNotesTools(stub<Parameters<typeof buildStickyNotesTools>[0]>()),
    ...buildCalendarTools(stub<Parameters<typeof buildCalendarTools>[0]>()),
    buildNotifyTool(stub<Parameters<typeof buildNotifyTool>[0]>()),
    buildPersonalSubagentTool(stub<Parameters<typeof buildPersonalSubagentTool>[0]>()),
    ...buildSubagentTools(stub<Parameters<typeof buildSubagentTools>[0]>()),
    ...buildQuestionTools(stub<Parameters<typeof buildQuestionTools>[0]>()),
    buildSkillTool(stub<SkillRegistry>(), "manager")
  ];
  return [...new Set([...packs.flatMap((pack) => pack.tools.map((t) => t.name)), ...personal.map((t) => t.name)])].sort();
}

test("every tool a chat can show reads as what it did, with an icon of its kind", () => {
  const names = chatToolNames();
  // Positive control: the list holds all three agents' tools.
  for (const name of ["bash", "create_worker", "list_threads", "canvas", "web_search", "web_fetch", "manage_schedule", "notify", "subagent", "stop_task", "ask_user", "skill", "task_board", "sticky_notes"]) expect([name, names.includes(name)]).toEqual([name, true]);
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
  // Positive control: the canvas tool that remains is in the list.
  expect(names.filter((name) => name.startsWith("canvas"))).toEqual(["canvas"]);
});
