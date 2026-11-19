import { expect, test } from "bun:test";
import {
  buildAgentScopePacks,
  buildCommonToolPacks,
  buildWorkerToolPacks,
  buildManagerToolPacks,
  getMandateModules
} from "../src/server/modules/registry.js";
import type { Database } from "bun:sqlite";
import type { MandateStore } from "../src/server/app/store.js";
import type { ManagerToolPackContext } from "../src/server/modules/module.js";
import type { SkillRegistry } from "../src/server/modules/skills/skill-registry.js";
import type { PaneMonitorManager } from "../src/server/modules/agent/pane-monitor-manager.js";
import type { WorkerScopeDeps } from "../src/server/runtime/scopes/worker-scope.js";
import type { ManagerScopeDeps } from "../src/server/runtime/scopes/manager-scope.js";
import type { PersonalScopeDeps } from "../src/server/modules/personal/personal-scope.js";
import { stub } from "./helpers/typed.js";
import type { SubagentScopeDeps } from "../src/server/runtime/scopes/subagent-scope.js";
import type { SideChatScopeDeps } from "../src/server/modules/side-chat/side-chat-scope.js";

test("module registry exposes unique module ids", () => {
  const ids = getMandateModules().map((module) => module.id);
  expect(new Set(ids).size).toBe(ids.length);
});

test("module registry includes route-owning modules", () => {
  const ids = getMandateModules().map((module) => module.id);
  expect(ids).toContain("projects");
  expect(ids).toContain("workers");
  expect(ids).toContain("agents");
  expect(ids).toContain("analysis");
  expect(ids).toContain("activity");
  expect(ids).toContain("state");
  expect(ids).toContain("canvas");
  expect(ids).toContain("panes");
  expect(ids).toContain("voice");
  expect(ids).toContain("settings");
});

test("module registry contributes agent scope packs", () => {
  const packs = buildAgentScopePacks({
    worker: stub<WorkerScopeDeps>(),
    manager: stub<ManagerScopeDeps>(),
    personal: stub<PersonalScopeDeps>(),
    subagent: stub<SubagentScopeDeps>(),
    sideChat: stub<SideChatScopeDeps>()
  });

  expect(packs.map((pack) => pack.scope)).toEqual(["worker", "manager", "subagent", "personal", "side_chat"]);
});

test("module registry contributes tool packs from modules", () => {
  const common = buildCommonToolPacks({
    scope: "worker",
    skillRegistry: stub<SkillRegistry>(),
    paneMonitorManager: stub<PaneMonitorManager>(),
    memory: null
  }).map((pack) => pack.id);
  const worker = buildWorkerToolPacks({ paneMonitorManager: stub<PaneMonitorManager>() }).map((pack) => pack.id);
  const manager = buildManagerToolPacks(stub<ManagerToolPackContext>()).map((pack) => pack.id);

  expect(common).toContain("agent.files");
  expect(common).toContain("agent.monitor");
  for (const scope of ["worker", "manager"] as const) {
    const names = buildCommonToolPacks({
      scope,
      skillRegistry: stub<SkillRegistry>(),
      paneMonitorManager: stub<PaneMonitorManager>(),
      memory: null
    }).flatMap((pack) => pack.tools.map((t) => t.name));
    expect([scope, names.filter((n) => /monitor|watch/.test(n)).sort()])
      .toEqual([scope, ["cancel_monitor", "list_my_monitors", "monitor"]]);
  }
  expect(common).toContain("skills.core");
  expect(buildCommonToolPacks({
    scope: "worker",
    store: stub<MandateStore>({ db: stub<Database>() }),
    skillRegistry: stub<SkillRegistry>(),
    paneMonitorManager: stub<PaneMonitorManager>(),
    memory: null
  }).map((pack) => pack.id)).toContain("agent.chat-history");
  expect(worker).toContain("panes.worker");
  expect(manager).toContain("projects.catalog");
  expect(manager).toContain("workers.lifecycle");
});
